import { test, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { retainMaterializedPaths } from '../../../materialized-path-registry.ts';
import {
  mockCleanupRetainedMaterializedPaths,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from '../../../handlers/__tests__/session-test-harness.ts';
import type { DaemonRequest } from '../../../types.ts';
import { handleSessionCommands } from '../../../handlers/__tests__/session-command-harness.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { withTestDeviceInventory } from '../../../../__tests__/test-utils/device-inventory-gateways.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';

test('devices filters Apple-family platform selectors', async () => {
  const sessionStore = makeSessionStore();
  const inventory: DeviceInfo[] = [
    {
      platform: 'android' as const,
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator' as const,
      target: 'mobile' as const,
      booted: true,
    },
    {
      platform: 'apple' as const,
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator' as const,
      target: 'mobile' as const,
      booted: true,
    },
    {
      platform: 'apple',
      appleOs: 'macos' as const,
      id: 'host-macos-local',
      name: 'Host Mac',
      kind: 'device' as const,
      target: 'desktop' as const,
      booted: true,
    },
  ];
  const runDevices = async (flags: DaemonRequest['flags']) =>
    await withTestDeviceInventory(
      { local: async () => inventory },
      async () =>
        await handleSessionCommands({
          req: {
            token: 't',
            session: 'default',
            command: 'devices',
            positionals: [],
            flags,
          },
          sessionName: 'default',
          logPath: path.join(os.tmpdir(), 'daemon.log'),
          sessionStore,
          invoke: noopInvoke,
        }),
    );

  const macosResponse = await runDevices({ platform: 'macos' });
  expect(macosResponse?.ok).toBeTruthy();
  if (macosResponse?.ok) {
    const devices = macosResponse.data?.devices as Array<{ platform: string }> | undefined;
    expect(devices?.map((device) => device.platform)).toEqual(['macos']);
  }

  const iosResponse = await runDevices({ platform: 'ios' });
  expect(iosResponse?.ok).toBeTruthy();
  if (iosResponse?.ok) {
    const devices = iosResponse.data?.devices as Array<{ platform: string }> | undefined;
    expect(devices?.map((device) => device.platform)).toEqual(['ios']);
  }

  const appleDesktopResponse = await runDevices({ platform: 'apple', target: 'desktop' });
  expect(appleDesktopResponse?.ok).toBeTruthy();
  if (appleDesktopResponse?.ok) {
    const devices = appleDesktopResponse.data?.devices as Array<{ platform: string }> | undefined;
    expect(devices?.map((device) => device.platform)).toEqual(['macos']);
  }
});

test('devices surfaces appleOs additively while keeping platform the public leaf', async () => {
  const sessionStore = makeSessionStore();
  const inventory = [
    {
      platform: 'apple' as const,
      id: 'sim-1',
      name: 'iPad Pro 11-inch (M4)',
      kind: 'simulator' as const,
      target: 'mobile' as const,
      appleOs: 'ipados' as const,
      booted: true,
      simulatorSetPath: '/tmp/agent-device-sim-set',
    },
  ];

  const response = await withTestDeviceInventory(
    { local: async () => inventory },
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'devices',
          positionals: [],
          flags: { platform: 'ios' },
        },
        sessionName: 'default',
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        invoke: noopInvoke,
      }),
  );

  expect(response?.ok).toBeTruthy();
  if (response?.ok) {
    const devices = response.data?.devices as Array<Record<string, unknown>> | undefined;
    expect(devices).toHaveLength(1);
    // appleOs is now surfaced additively (iPad -> ipados) ...
    expect(devices?.[0]?.appleOs).toBe('ipados');
    // ... while `platform` stays the PUBLIC leaf (never the internal `apple`).
    expect(devices?.[0]?.platform).toBe('ios');
    // The internal-only simulator set path is still stripped from the public shape.
    expect(devices?.[0]).not.toHaveProperty('simulatorSetPath');
    expect(devices?.[0]?.id).toBe('sim-1');
  }
});

test('batch stops on first failing step with partial results', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      flags: {
        batchSteps: [
          { command: 'open', positionals: ['settings'] },
          { command: 'click', positionals: ['@e1'] },
        ],
      },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (stepReq) => {
      if (stepReq.command === 'click') {
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: 'missing target',
            hint: 'refresh selector',
            diagnosticId: 'diag-step-2',
            logPath: '/tmp/diag-step-2.ndjson',
          },
        };
      }
      return { ok: true, data: {} };
    },
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/Batch failed at step 2/);
    expect(response.error.details?.step).toBe(2);
    expect(response.error.details?.executed).toBe(1);
    expect(response.error.hint).toBe('refresh selector');
    expect(response.error.diagnosticId).toBe('diag-step-2');
    expect(response.error.logPath).toBe('/tmp/diag-step-2.ndjson');
    const partial = response.error.details?.partialResults;
    expect(Array.isArray(partial)).toBeTruthy();
    expect((partial as unknown[]).length).toBe(1);
  }
});

test('batch rejects nested replay and batch commands', async () => {
  const sessionStore = makeSessionStore();
  const nestedReplay = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      flags: {
        batchSteps: [{ command: 'replay', positionals: ['./flow.ad'] }],
      },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(nestedReplay).toBeTruthy();
  expect(nestedReplay?.ok).toBe(false);
  if (nestedReplay && !nestedReplay.ok) {
    expect(nestedReplay.error.code).toBe('INVALID_ARGS');
  }

  const nestedBatch = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      flags: {
        batchSteps: [{ command: 'batch', positionals: [] }],
      },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(nestedBatch).toBeTruthy();
  expect(nestedBatch?.ok).toBe(false);
  if (nestedBatch && !nestedBatch.ok) {
    expect(nestedBatch.error.code).toBe('INVALID_ARGS');
  }
});

test('batch step flags override parent selector flags', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      flags: {
        platform: 'ios',
        batchSteps: [
          {
            command: 'open',
            positionals: ['settings'],
            flags: { platform: 'android' },
          },
        ],
      },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (stepReq) => {
      expect(stepReq.flags?.platform).toBe('android');
      return { ok: true, data: {} };
    },
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
});

// #1900: `batch` (`session-batch.ts` -> `runBatch`) just re-invokes each step through the normal
// `DaemonInvokeFn` with no platform branching of its own, so a web platform selector threads
// through the same way any other platform selector does.
test('batch step forwards the parent web platform selector to each invoked step', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      flags: {
        platform: 'web',
        batchSteps: [
          { command: 'open', positionals: ['http://127.0.0.1/'] },
          { command: 'screenshot', positionals: ['/tmp/web-batch.png'] },
        ],
      },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (stepReq) => {
      expect(stepReq.flags?.platform).toBe('web');
      return { ok: true, data: {} };
    },
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
});

test('batch step forwards typed runtime payload', async () => {
  const sessionStore = makeSessionStore();
  const seenRuntimes: Array<DaemonRequest['runtime']> = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      flags: {
        batchSteps: [
          {
            command: 'open',
            positionals: ['Demo'],
            flags: { platform: 'android' },
            runtime: {
              metroHost: '10.0.0.10',
              metroPort: 8081,
            },
          },
        ],
      },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (stepReq) => {
      seenRuntimes.push(stepReq.runtime);
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBe(true);
  expect(seenRuntimes).toEqual([
    {
      metroHost: '10.0.0.10',
      metroPort: 8081,
    },
  ]);
});

test('batch step inherits parent runtime unless the step overrides it', async () => {
  const sessionStore = makeSessionStore();
  const seenRuntimes: Array<DaemonRequest['runtime']> = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      runtime: {
        platform: 'android',
        bundleUrl: 'https://bundle.example.test',
      },
      flags: {
        batchSteps: [
          {
            command: 'open',
            positionals: ['Demo'],
          },
          {
            command: 'open',
            positionals: ['Demo'],
            runtime: {
              metroHost: '10.0.0.10',
              metroPort: 8081,
            },
          },
        ],
      },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (stepReq) => {
      seenRuntimes.push(stepReq.runtime);
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBe(true);
  expect(seenRuntimes).toEqual([
    {
      platform: 'android',
      bundleUrl: 'https://bundle.example.test',
    },
    {
      metroHost: '10.0.0.10',
      metroPort: 8081,
    },
  ]);
});

test('batch step pins nested requests to the resolved session', async () => {
  const sessionStore = makeSessionStore();
  const seenSessions: Array<{ session: string; flagSession: string | undefined }> = [];

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      flags: {
        batchSteps: [{ command: 'wait', positionals: ['100'] }],
      },
    },
    sessionName: 'resolved-session',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (stepReq) => {
      seenSessions.push({
        session: stepReq.session,
        flagSession: stepReq.flags?.session,
      });
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBe(true);
  expect(seenSessions).toEqual([
    {
      session: 'resolved-session',
      flagSession: 'resolved-session',
    },
  ]);
});

test('close clears retained materialized install paths bound to the session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'materialized-close-active';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
  });
  const tempRoot = mkdtempForTestSync('agent-device-session-materialized-');
  const appPath = path.join(tempRoot, 'Sample.app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Info.plist'), 'plist');
  const retained = await retainMaterializedPaths({
    installablePath: appPath,
    sessionName,
    ttlMs: 60_000,
  });

  // Use real cleanup implementation so retained paths are actually removed
  const { cleanupRetainedMaterializedPathsForSession: realCleanup } = await vi.importActual<
    typeof import('../../../materialized-path-registry.ts')
  >('../../../materialized-path-registry.ts');
  mockCleanupRetainedMaterializedPaths.mockImplementation(realCleanup);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(sessionStore.get(sessionName)).toBe(undefined);
  expect(fs.existsSync(retained.installablePath)).toBe(false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('release_materialized_paths removes retained install artifacts', async () => {
  const sessionStore = makeSessionStore();
  const tempRoot = mkdtempForTestSync('agent-device-release-materialized-');
  const appPath = path.join(tempRoot, 'Sample.app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Info.plist'), 'plist');
  const retained = await retainMaterializedPaths({
    installablePath: appPath,
    ttlMs: 60_000,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'release_materialized_paths',
      positionals: [],
      flags: {},
      meta: {
        materializationId: retained.materializationId,
      },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(fs.existsSync(retained.installablePath)).toBe(false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('devices projects the blocking claim owner and hides provably dead owners', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-devices-claims-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  const owner = readCurrentOwnerIdentity();
  const writeClaim = (id: string, ownerPid: number, ownerStartTime: string | null) => {
    fs.writeFileSync(
      path.join(claimsDir, `${id}.json`),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey: `local:android:none:${id}`,
        device: { platform: 'android', id, name: id, kind: 'emulator' },
        session: `${id}-session`,
        workspace: `/worktrees/${id}`,
        stateDir: process.cwd(),
        ownerPid,
        ownerStartTime,
        ownerToken: `${id}-token`,
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );
  };
  writeClaim('emulator-5554', owner.pid, owner.startTime);
  writeClaim('emulator-5556', 999_999_999, 'long-gone');
  const sessionStore = makeSessionStore();
  const inventory: DeviceInfo[] = [
    makeAndroidInventoryDevice('emulator-5554'),
    makeAndroidInventoryDevice('emulator-5556'),
  ];
  try {
    const response = await withTestDeviceInventory(
      { local: async () => inventory },
      async () =>
        await handleSessionCommands({
          req: {
            token: 't',
            session: 'default',
            command: 'devices',
            positionals: [],
            flags: { platform: 'android' },
          },
          sessionName: 'default',
          logPath: path.join(os.tmpdir(), 'daemon.log'),
          sessionStore,
          invoke: noopInvoke,
        }),
    );
    expect(response?.ok).toBeTruthy();
    if (response?.ok) {
      const devices = response.data?.devices as Array<Record<string, unknown>> | undefined;
      expect(devices).toHaveLength(2);
      expect(devices?.[0]?.claimedBy).toEqual({
        session: 'emulator-5554-session',
        workspace: '/worktrees/emulator-5554',
      });
      // The dead owner is not projected: the next open reconciles and replaces it.
      expect(devices?.[1]?.claimedBy).toBeUndefined();
    }
  } finally {
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

function makeAndroidInventoryDevice(id: string): DeviceInfo {
  return {
    platform: 'android',
    id,
    name: id,
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  };
}

test('a claim never projects onto a same-id device from another platform family', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-devices-claims-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  const owner = readCurrentOwnerIdentity();
  fs.writeFileSync(
    path.join(claimsDir, 'shared-id.json'),
    JSON.stringify({
      schemaVersion: 1,
      deviceKey: 'local:android:none:shared-id',
      device: { platform: 'android', id: 'shared-id', name: 'Claimed Pixel', kind: 'emulator' },
      session: 'android-session',
      workspace: '/worktrees/android',
      stateDir: process.cwd(),
      ownerPid: owner.pid,
      ownerStartTime: owner.startTime,
      ownerToken: 'shared-id-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
  const sessionStore = makeSessionStore();
  const inventory: DeviceInfo[] = [
    {
      platform: 'apple',
      appleOs: 'ios',
      id: 'shared-id',
      name: 'Colliding iPhone',
      kind: 'simulator',
      target: 'mobile',
      booted: true,
    },
    makeAndroidInventoryDevice('shared-id'),
  ];
  try {
    const response = await withTestDeviceInventory(
      { local: async () => inventory },
      async () =>
        await handleSessionCommands({
          req: {
            token: 't',
            session: 'default',
            command: 'devices',
            positionals: [],
            flags: {},
          },
          sessionName: 'default',
          logPath: path.join(os.tmpdir(), 'daemon.log'),
          sessionStore,
          invoke: noopInvoke,
        }),
    );
    expect(response?.ok).toBeTruthy();
    if (response?.ok) {
      const devices = response.data?.devices as Array<Record<string, unknown>> | undefined;
      expect(devices).toHaveLength(2);
      const byPlatform = new Map(devices?.map((row) => [row.platform, row]));
      // Claim ownership is canonical family/OS/id: the Android claim must not
      // appear on the Apple row that happens to share the bare id.
      expect(byPlatform.get('ios')?.claimedBy).toBeUndefined();
      expect(byPlatform.get('android')?.claimedBy).toEqual({
        session: 'android-session',
        workspace: '/worktrees/android',
      });
    }
  } finally {
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});
