import { test, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { retainMaterializedPaths } from '../../materialized-path-registry.ts';
import {
  mockClearRuntimeHints,
  mockCleanupRetainedMaterializedPaths,
  mockListAndroidDevices,
  mockListAppleDevices,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from './session-test-harness.ts';
import type { DaemonRequest } from '../../types.ts';
import { handleSessionCommands } from '../session.ts';

test('devices filters Apple-family platform selectors', async () => {
  const sessionStore = makeSessionStore();
  mockListAndroidDevices.mockResolvedValue([
    {
      platform: 'android' as const,
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator' as const,
      target: 'mobile' as const,
      booted: true,
    },
  ]);
  mockListAppleDevices.mockResolvedValue([
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
  ]);
  const runDevices = async (flags: DaemonRequest['flags']) =>
    handleSessionCommands({
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
    });

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
  mockListAndroidDevices.mockResolvedValue([]);
  mockListAppleDevices.mockResolvedValue([
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
  ]);

  const response = await handleSessionCommands({
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
  });

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

test('runtime set/show/clear manages session-scoped runtime hints before open', async () => {
  const sessionStore = makeSessionStore();
  const baseRequest = {
    token: 't',
    session: 'remote-runtime',
  } satisfies Pick<DaemonRequest, 'token' | 'session'>;

  const setResponse = await handleSessionCommands({
    req: {
      ...baseRequest,
      command: 'runtime',
      positionals: ['set'],
      flags: {
        platform: 'android',
        metroHost: '10.0.0.10',
        metroPort: 8081,
        launchUrl: 'myapp://dev-client',
      },
    },
    sessionName: 'remote-runtime',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(setResponse?.ok).toBe(true);

  const showResponse = await handleSessionCommands({
    req: {
      ...baseRequest,
      command: 'runtime',
      positionals: ['show'],
      flags: {},
    },
    sessionName: 'remote-runtime',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(showResponse?.ok).toBe(true);
  if (showResponse && showResponse.ok) {
    expect(showResponse.data?.configured).toBe(true);
    expect(showResponse.data?.runtime).toEqual({
      platform: 'android',
      metroHost: '10.0.0.10',
      metroPort: 8081,
      bundleUrl: undefined,
      launchUrl: 'myapp://dev-client',
    });
  }

  const clearResponse = await handleSessionCommands({
    req: {
      ...baseRequest,
      command: 'runtime',
      positionals: ['clear'],
      flags: {},
    },
    sessionName: 'remote-runtime',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(clearResponse?.ok).toBe(true);
  expect(sessionStore.getRuntimeHints('remote-runtime')).toBe(undefined);
});

test('runtime clear removes applied transport hints for the active app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-clear-active';
  sessionStore.setRuntimeHints(sessionName, {
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
  });
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.demo',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'runtime',
      positionals: ['clear'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(mockClearRuntimeHints).toHaveBeenCalledWith(
    expect.objectContaining({
      device: expect.objectContaining({ id: 'emulator-5554' }),
      appId: 'com.example.demo',
    }),
  );
  expect(sessionStore.getRuntimeHints(sessionName)).toBe(undefined);
});

test('close clears applied runtime transport hints before deleting the session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-close-active';
  sessionStore.setRuntimeHints(sessionName, {
    platform: 'ios',
    metroHost: '127.0.0.1',
    metroPort: 8081,
  });
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.example.demo',
  });

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
  expect(mockClearRuntimeHints).toHaveBeenCalled();
  expect(sessionStore.get(sessionName)).toBe(undefined);
  expect(sessionStore.getRuntimeHints(sessionName)).toBe(undefined);
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-session-materialized-'));
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
    typeof import('../../materialized-path-registry.ts')
  >('../../materialized-path-registry.ts');
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-release-materialized-'));
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
