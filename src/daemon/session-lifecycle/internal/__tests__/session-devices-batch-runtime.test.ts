import { test, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../materialized-path-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../materialized-path-registry.ts')>();
  return { ...actual, cleanupRetainedMaterializedPathsForSession: vi.fn(async () => {}) };
});

import {
  cleanupRetainedMaterializedPathsForSession,
  retainMaterializedPaths,
} from '../../../materialized-path-registry.ts';
import { handleSessionInventoryCommands } from '../inventory.ts';
import { runBatchCommands } from '../../../handlers/session-batch.ts';
import { handleReleaseMaterializedPathsCommand } from '../../../handlers/session-app-source-deployment.ts';
import { handleSessionCommands } from '../../../handlers/__tests__/session-command-harness.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { makeSession } from '../../../../__tests__/test-utils/session-factories.ts';
import type { DaemonRequest, DaemonResponse } from '../../../daemon-request.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { withTestDeviceInventory } from '../../../../__tests__/test-utils/device-inventory-gateways.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';

const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({
  ok: true,
  data: {},
});

const mockCleanupRetainedMaterializedPaths = vi.mocked(cleanupRetainedMaterializedPathsForSession);

async function runDevices(
  flags: DaemonRequest['flags'],
  inventory: readonly DeviceInfo[],
): Promise<DaemonResponse | null> {
  return await withTestDeviceInventory(
    { local: async () => inventory },
    async () =>
      await handleSessionInventoryCommands({
        req: { token: 't', session: 'default', command: 'devices', positionals: [], flags },
        sessionName: 'default',
        sessionStore: makeSessionStore('agent-device-devices-batch-runtime-'),
      }),
  );
}

test('devices filters Apple-family platform selectors', async () => {
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

  const macosResponse = await runDevices({ platform: 'macos' }, inventory);
  expect(macosResponse?.ok).toBeTruthy();
  if (macosResponse?.ok) {
    const devices = macosResponse.data?.devices as Array<{ platform: string }> | undefined;
    expect(devices?.map((device) => device.platform)).toEqual(['macos']);
  }

  const iosResponse = await runDevices({ platform: 'ios' }, inventory);
  expect(iosResponse?.ok).toBeTruthy();
  if (iosResponse?.ok) {
    const devices = iosResponse.data?.devices as Array<{ platform: string }> | undefined;
    expect(devices?.map((device) => device.platform)).toEqual(['ios']);
  }

  const appleDesktopResponse = await runDevices(
    { platform: 'apple', target: 'desktop' },
    inventory,
  );
  expect(appleDesktopResponse?.ok).toBeTruthy();
  if (appleDesktopResponse?.ok) {
    const devices = appleDesktopResponse.data?.devices as Array<{ platform: string }> | undefined;
    expect(devices?.map((device) => device.platform)).toEqual(['macos']);
  }
});

test('devices surfaces appleOs additively while keeping platform the public leaf', async () => {
  const inventory: DeviceInfo[] = [
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

  const response = await runDevices({ platform: 'ios' }, inventory);

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
  const response = await runBatchCommands(
    {
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
    'default',
    async (stepReq) => {
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
  );
  expect(response).toBeTruthy();
  expect(response.ok).toBe(false);
  if (!response.ok) {
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
  const nestedReplay = await runBatchCommands(
    {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      flags: { batchSteps: [{ command: 'replay', positionals: ['./flow.ad'] }] },
    },
    'default',
    noopInvoke,
  );
  expect(nestedReplay).toBeTruthy();
  expect(nestedReplay.ok).toBe(false);
  if (!nestedReplay.ok) {
    expect(nestedReplay.error.code).toBe('INVALID_ARGS');
  }

  const nestedBatch = await runBatchCommands(
    {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      flags: { batchSteps: [{ command: 'batch', positionals: [] }] },
    },
    'default',
    noopInvoke,
  );
  expect(nestedBatch).toBeTruthy();
  expect(nestedBatch.ok).toBe(false);
  if (!nestedBatch.ok) {
    expect(nestedBatch.error.code).toBe('INVALID_ARGS');
  }
});

test('batch step flags override parent selector flags', async () => {
  const response = await runBatchCommands(
    {
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
    'default',
    async (stepReq) => {
      expect(stepReq.flags?.platform).toBe('android');
      return { ok: true, data: {} };
    },
  );
  expect(response).toBeTruthy();
  expect(response.ok).toBe(true);
});

// #1900: `batch` (`session-batch.ts` -> `runBatch`) just re-invokes each step through the normal
// `DaemonInvokeFn` with no platform branching of its own, so a web platform selector threads
// through the same way any other platform selector does.
test('batch step forwards the parent web platform selector to each invoked step', async () => {
  const response = await runBatchCommands(
    {
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
    'default',
    async (stepReq) => {
      expect(stepReq.flags?.platform).toBe('web');
      return { ok: true, data: {} };
    },
  );
  expect(response).toBeTruthy();
  expect(response.ok).toBe(true);
});

test('batch step forwards typed runtime payload', async () => {
  const seenRuntimes: Array<DaemonRequest['runtime']> = [];
  const response = await runBatchCommands(
    {
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
            runtime: { metroHost: '10.0.0.10', metroPort: 8081 },
          },
        ],
      },
    },
    'default',
    async (stepReq) => {
      seenRuntimes.push(stepReq.runtime);
      return { ok: true, data: {} };
    },
  );

  expect(response.ok).toBe(true);
  expect(seenRuntimes).toEqual([{ metroHost: '10.0.0.10', metroPort: 8081 }]);
});

test('batch step inherits parent runtime unless the step overrides it', async () => {
  const seenRuntimes: Array<DaemonRequest['runtime']> = [];
  const response = await runBatchCommands(
    {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      runtime: { platform: 'android', bundleUrl: 'https://bundle.example.test' },
      flags: {
        batchSteps: [
          { command: 'open', positionals: ['Demo'] },
          {
            command: 'open',
            positionals: ['Demo'],
            runtime: { metroHost: '10.0.0.10', metroPort: 8081 },
          },
        ],
      },
    },
    'default',
    async (stepReq) => {
      seenRuntimes.push(stepReq.runtime);
      return { ok: true, data: {} };
    },
  );

  expect(response.ok).toBe(true);
  expect(seenRuntimes).toEqual([
    { platform: 'android', bundleUrl: 'https://bundle.example.test' },
    { metroHost: '10.0.0.10', metroPort: 8081 },
  ]);
});

test('batch step pins nested requests to the resolved session', async () => {
  const seenSessions: Array<{ session: string; flagSession: string | undefined }> = [];

  const response = await runBatchCommands(
    {
      token: 't',
      session: 'default',
      command: 'batch',
      positionals: [],
      flags: { batchSteps: [{ command: 'wait', positionals: ['100'] }] },
    },
    'resolved-session',
    async (stepReq) => {
      seenSessions.push({ session: stepReq.session, flagSession: stepReq.flags?.session });
      return { ok: true, data: {} };
    },
  );

  expect(response.ok).toBe(true);
  expect(seenSessions).toEqual([{ session: 'resolved-session', flagSession: 'resolved-session' }]);
});

test('close clears retained materialized install paths bound to the session', async () => {
  const sessionStore = makeSessionStore('agent-device-devices-batch-runtime-');
  const sessionName = 'materialized-close-active';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 17 Pro',
        kind: 'simulator',
        booted: true,
      },
    }),
  );
  const tempRoot = mkdtempForTestSync('agent-device-session-materialized-');
  const appPath = path.join(tempRoot, 'Sample.app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Info.plist'), 'plist');
  const retained = await retainMaterializedPaths({
    installablePath: appPath,
    sessionName,
    ttlMs: 60_000,
  });

  // Use the real cleanup implementation so the retained path is actually removed.
  const { cleanupRetainedMaterializedPathsForSession: realCleanup } = await vi.importActual<
    typeof import('../../../materialized-path-registry.ts')
  >('../../../materialized-path-registry.ts');
  mockCleanupRetainedMaterializedPaths.mockImplementation(realCleanup);

  const response = await handleSessionCommands({
    req: { token: 't', session: sessionName, command: 'close', positionals: [], flags: {} },
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
  const tempRoot = mkdtempForTestSync('agent-device-release-materialized-');
  const appPath = path.join(tempRoot, 'Sample.app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Info.plist'), 'plist');
  const retained = await retainMaterializedPaths({ installablePath: appPath, ttlMs: 60_000 });

  const response = await handleReleaseMaterializedPathsCommand({
    req: {
      token: 't',
      session: 'default',
      command: 'release_materialized_paths',
      positionals: [],
      flags: {},
      meta: { materializationId: retained.materializationId },
    },
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
  const inventory: DeviceInfo[] = [
    makeAndroidInventoryDevice('emulator-5554'),
    makeAndroidInventoryDevice('emulator-5556'),
  ];
  try {
    const response = await runDevices({ platform: 'android' }, inventory);
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

test('an allocator-held claim does not project claimedBy', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-devices-allocator-claims-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  // ADR 0021 foundations: the public `claimedBy` shape is `{ session, workspace }` and an
  // allocator-held claim has neither, so a managed identity surfaces unclaimed until the Host
  // inventory filter lands.
  fs.writeFileSync(
    path.join(claimsDir, 'managed.json'),
    JSON.stringify({
      schemaVersion: 3,
      kind: 'allocator',
      deviceKey: 'local:android:none:emulator-5554',
      device: { family: 'android', id: 'emulator-5554', name: 'emulator-5554', kind: 'emulator' },
      stateDir: process.cwd(),
      allocator: { instanceId: 'sim-a', identityIncarnationId: 'incarnation-1' },
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
  const inventory: DeviceInfo[] = [makeAndroidInventoryDevice('emulator-5554')];
  try {
    const response = await runDevices({ platform: 'android' }, inventory);
    expect(response?.ok).toBeTruthy();
    if (response?.ok) {
      const devices = response.data?.devices as Array<Record<string, unknown>> | undefined;
      expect(devices).toHaveLength(1);
      expect(devices?.[0]?.claimedBy).toBeUndefined();
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
    const response = await runDevices({}, inventory);
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
