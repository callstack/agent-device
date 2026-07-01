import { isMacOs } from '../../../kernel/device.ts';
import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});
vi.mock('../../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('../../runtime-hints.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime-hints.ts')>();
  return {
    ...actual,
    applyRuntimeHintsToApp: vi.fn(async () => {}),
    clearRuntimeHintsFromApp: vi.fn(async () => {}),
  };
});
vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return {
    ...actual,
    prepareIosRunner: vi.fn(async () => ({
      runner: { currentUptimeMs: 42 },
      connectMs: 3,
      healthCheckMs: 3,
    })),
    prewarmAppleRunnerCache: vi.fn(),
    prewarmIosRunnerSession: vi.fn(),
    stopIosRunnerSession: vi.fn(async () => {}),
  };
});
vi.mock('../../../platforms/apple/os/macos/helper.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/os/macos/helper.ts')>();
  return { ...actual, runMacOsAlertAction: vi.fn(async () => {}) };
});
vi.mock('../session-device-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-device-utils.ts')>();
  return { ...actual, settleIosSimulator: vi.fn(async () => {}) };
});
vi.mock('../session-open-target.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-open-target.ts')>();
  return { ...actual, resolveAndroidPackageForOpen: vi.fn(async () => undefined) };
});
vi.mock('../../../platforms/apple/core/simulator.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/simulator.ts')>();
  return { ...actual, getSimulatorState: vi.fn(async () => null), shutdownSimulator: vi.fn() };
});
vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) };
});
vi.mock('../../materialized-path-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../materialized-path-registry.ts')>();
  return { ...actual, cleanupRetainedMaterializedPathsForSession: vi.fn(async () => {}) };
});
vi.mock('../../../platforms/android/devices.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platforms/android/devices.ts')>();
  return {
    ...actual,
    listAndroidDevices: vi.fn(async () => []),
    ensureAndroidEmulatorBooted: vi.fn(),
  };
});
vi.mock('../../../platforms/apple/core/devices.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platforms/apple/core/devices.ts')>();
  return { ...actual, listAppleDevices: vi.fn(async () => []) };
});
vi.mock('../../../platforms/apple/core/apps.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platforms/apple/core/apps.ts')>();
  return {
    ...actual,
    listIosApps: vi.fn(async () => []),
    resolveIosApp: vi.fn(async () => undefined),
    resolveIosSimulatorDeepLinkBundleId: vi.fn(async () => undefined),
  };
});
vi.mock('../../app-log.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app-log.ts')>();
  return { ...actual, startAppLog: vi.fn(), stopAppLog: vi.fn(async () => {}) };
});
vi.mock('../session-deploy.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-deploy.ts')>();
  return {
    ...actual,
    defaultInstallOps: { ios: vi.fn(), android: vi.fn() },
    defaultReinstallOps: { ios: vi.fn(), android: vi.fn() },
  };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleSessionCommands } from '../session.ts';
import { buildSnapshotSignatures } from '../../android-snapshot-freshness.ts';
import {
  retainMaterializedPaths,
  cleanupRetainedMaterializedPathsForSession,
} from '../../materialized-path-registry.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import { AppError } from '../../../kernel/errors.ts';
import { dispatchCommand, resolveTargetDevice } from '../../../core/dispatch.ts';
import { ensureDeviceReady } from '../../device-ready.ts';
import { applyRuntimeHintsToApp, clearRuntimeHintsFromApp } from '../../runtime-hints.ts';
import {
  prepareIosRunner,
  prewarmAppleRunnerCache,
  prewarmIosRunnerSession,
  stopIosRunnerSession,
} from '../../../platforms/apple/core/runner/runner-client.ts';
import { runMacOsAlertAction } from '../../../platforms/apple/os/macos/helper.ts';
import { settleIosSimulator } from '../session-device-utils.ts';
import { resolveAndroidPackageForOpen } from '../session-open-target.ts';
import { runCmd } from '../../../utils/exec.ts';
import { shutdownSimulator } from '../../../platforms/apple/core/simulator.ts';
import {
  listAndroidDevices,
  ensureAndroidEmulatorBooted,
} from '../../../platforms/android/devices.ts';
import { listAppleDevices } from '../../../platforms/apple/core/devices.ts';
import {
  resolveIosApp,
  resolveIosSimulatorDeepLinkBundleId,
} from '../../../platforms/apple/core/apps.ts';
import { startAppLog, stopAppLog } from '../../app-log.ts';
import { defaultInstallOps, defaultReinstallOps } from '../session-deploy.ts';
import { clearRequestCanceled, markRequestCanceled } from '../../request-cancel.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);
const mockApplyRuntimeHints = vi.mocked(applyRuntimeHintsToApp);
const mockClearRuntimeHints = vi.mocked(clearRuntimeHintsFromApp);
const mockPrewarmIosRunnerSession = vi.mocked(prewarmIosRunnerSession);
const mockPrewarmAppleRunnerCache = vi.mocked(prewarmAppleRunnerCache);
const mockPrepareIosRunner = vi.mocked(prepareIosRunner);
const mockStopIosRunner = vi.mocked(stopIosRunnerSession);
const mockDismissMacOsAlert = vi.mocked(runMacOsAlertAction);
const mockSettleSimulator = vi.mocked(settleIosSimulator);
const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);
const mockCleanupRetainedMaterializedPaths = vi.mocked(cleanupRetainedMaterializedPathsForSession);
const mockRunCmd = vi.mocked(runCmd);
const mockShutdownSimulator = vi.mocked(shutdownSimulator);
const mockListAndroidDevices = vi.mocked(listAndroidDevices);
const mockListAppleDevices = vi.mocked(listAppleDevices);
const mockResolveIosApp = vi.mocked(resolveIosApp);
const mockResolveIosSimulatorDeepLinkBundleId = vi.mocked(resolveIosSimulatorDeepLinkBundleId);
const mockEnsureAndroidEmulatorBooted = vi.mocked(ensureAndroidEmulatorBooted);
const mockStartAppLog = vi.mocked(startAppLog);
const mockStopAppLog = vi.mocked(stopAppLog);
const mockDefaultInstallOpsIos = vi.mocked(defaultInstallOps.ios);
const mockDefaultInstallOpsAndroid = vi.mocked(defaultInstallOps.android);
const mockDefaultReinstallOpsIos = vi.mocked(defaultReinstallOps.ios);
const mockDefaultReinstallOpsAndroid = vi.mocked(defaultReinstallOps.android);

beforeEach(() => {
  vi.useRealTimers();
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockResolveTargetDevice.mockReset();
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
  mockApplyRuntimeHints.mockReset();
  mockApplyRuntimeHints.mockResolvedValue(undefined);
  mockClearRuntimeHints.mockReset();
  mockClearRuntimeHints.mockResolvedValue(undefined);
  mockPrewarmIosRunnerSession.mockReset();
  mockPrewarmAppleRunnerCache.mockReset();
  mockPrepareIosRunner.mockReset();
  mockPrepareIosRunner.mockResolvedValue({
    runner: { currentUptimeMs: 42 },
    connectMs: 3,
    healthCheckMs: 3,
  });
  mockStopIosRunner.mockReset();
  mockStopIosRunner.mockResolvedValue(undefined);
  mockDismissMacOsAlert.mockReset();
  mockDismissMacOsAlert.mockResolvedValue({} as any);
  mockSettleSimulator.mockReset();
  mockSettleSimulator.mockResolvedValue(undefined);
  mockResolveAndroidPackage.mockReset();
  mockResolveAndroidPackage.mockResolvedValue(undefined);
  mockCleanupRetainedMaterializedPaths.mockReset();
  mockCleanupRetainedMaterializedPaths.mockResolvedValue(undefined);
  mockRunCmd.mockReset();
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  mockShutdownSimulator.mockReset();
  mockShutdownSimulator.mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '' });
  mockListAndroidDevices.mockReset();
  mockListAndroidDevices.mockResolvedValue([]);
  mockListAppleDevices.mockReset();
  mockListAppleDevices.mockResolvedValue([]);
  mockResolveIosApp.mockReset();
  mockResolveIosApp.mockImplementation(async (device, app) => {
    const normalizedApp = app.toLowerCase();
    if (normalizedApp === 'settings') {
      return isMacOs(device) ? 'com.apple.systempreferences' : 'com.apple.Preferences';
    }
    if (normalizedApp === 'menubarapp') {
      return 'com.example.menubarapp';
    }
    return app.includes('.') ? app : `com.example.${normalizedApp}`;
  });
  mockResolveIosSimulatorDeepLinkBundleId.mockReset();
  mockResolveIosSimulatorDeepLinkBundleId.mockResolvedValue(undefined);
  mockEnsureAndroidEmulatorBooted.mockReset();
  mockStartAppLog.mockReset();
  mockStopAppLog.mockReset();
  mockStopAppLog.mockResolvedValue(undefined);
  mockDefaultInstallOpsIos.mockReset();
  mockDefaultInstallOpsAndroid.mockReset();
  mockDefaultReinstallOpsIos.mockReset();
  mockDefaultReinstallOpsAndroid.mockReset();
});

function makeSessionStore(): SessionStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-session-handler-'));
  return new SessionStore(path.join(root, 'sessions'));
}

function makeSession(name: string, device: SessionState['device']): SessionState {
  return {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
  };
}

const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({ ok: true, data: {} });

function assertInvalidArgsMessage(response: DaemonResponse | null, message: string): void {
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe(message);
  }
}

async function withMockedPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

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

test('devices omits internal appleOs from the public inventory projection', async () => {
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
    expect(devices?.[0]).not.toHaveProperty('appleOs');
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

test('boot requires session or explicit selector', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
  }
});

test('boot prefers explicit device selector over active session device', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
  );
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'boot',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockEnsureDeviceReady).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'sim-2' }),
    expect.any(Object),
  );
  const onColdBootStart = mockEnsureDeviceReady.mock.calls[0]?.[1]?.onIosSimulatorColdBootStart;
  expect(onColdBootStart).toBeTypeOf('function');
  onColdBootStart?.(selectedDevice);
  expect(mockPrewarmAppleRunnerCache).toHaveBeenCalledWith(
    selectedDevice,
    expect.objectContaining({
      logPath: expect.stringMatching(/daemon\.log$/),
    }),
  );
  if (response && response.ok) {
    expect(response.data?.platform).toBe('ios');
    expect(response.data?.id).toBe('sim-2');
  }
});

test('boot --headless launches Android emulator when no running device matches', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockRejectedValue(new AppError('DEVICE_NOT_FOUND', 'No device found'));
  const launchCalls: Array<{ avdName: string; serial?: string; headless?: boolean }> = [];
  mockEnsureAndroidEmulatorBooted.mockImplementation(async ({ avdName, serial, headless }) => {
    launchCalls.push({ avdName, serial, headless });
    return {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel_9_Pro_XL',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    };
  });
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android', device: 'Pixel_9_Pro_XL', headless: true },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(launchCalls).toEqual([{ avdName: 'Pixel_9_Pro_XL', serial: undefined, headless: true }]);
  expect(mockEnsureDeviceReady).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'emulator-5554' }),
  );
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.device).toBe('Pixel_9_Pro_XL');
  }
});

test('boot launches Android emulator with GUI when no running device matches', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockRejectedValue(new AppError('DEVICE_NOT_FOUND', 'No device found'));
  const launchCalls: Array<{ avdName: string; serial?: string; headless?: boolean }> = [];
  mockEnsureAndroidEmulatorBooted.mockImplementation(async ({ avdName, serial, headless }) => {
    launchCalls.push({ avdName, serial, headless });
    return {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel_9_Pro_XL',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    };
  });
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android', device: 'Pixel_9_Pro_XL' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(launchCalls).toEqual([{ avdName: 'Pixel_9_Pro_XL', serial: undefined, headless: false }]);
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.device).toBe('Pixel_9_Pro_XL');
  }
});

test('boot launches stopped Android emulator selected from inventory', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'Pixel_9_Pro_XL',
    name: 'Pixel_9_Pro_XL',
    kind: 'emulator',
    target: 'mobile',
    booted: false,
  });
  const launchCalls: Array<{ avdName: string; serial?: string; headless?: boolean }> = [];
  mockEnsureAndroidEmulatorBooted.mockImplementation(async ({ avdName, serial, headless }) => {
    launchCalls.push({ avdName, serial, headless });
    return {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel_9_Pro_XL',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(launchCalls).toEqual([{ avdName: 'Pixel_9_Pro_XL', serial: undefined, headless: false }]);
  expect(mockEnsureDeviceReady).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'emulator-5554', booted: true }),
  );
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.device).toBe('Pixel_9_Pro_XL');
  }
});

test('boot --headless requires avd selector when device cannot be resolved', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockRejectedValue(new AppError('DEVICE_NOT_FOUND', 'No device found'));
  mockEnsureAndroidEmulatorBooted.mockRejectedValue(new Error('unexpected'));
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android', serial: 'emulator-5554', headless: true },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockEnsureAndroidEmulatorBooted).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/boot --headless requires --device <avd-name>/);
  }
});

test('boot --headless rejects non-Android selectors', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro', headless: true },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockEnsureAndroidEmulatorBooted).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/headless is supported only for Android emulators/i);
  }
});

test('boot keeps --target validation when emulator is fallback-launched', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockRejectedValue(new AppError('DEVICE_NOT_FOUND', 'No device found'));
  const launchCalls: Array<{ avdName: string; serial?: string; headless?: boolean }> = [];
  mockEnsureAndroidEmulatorBooted.mockImplementation(async ({ avdName, serial, headless }) => {
    launchCalls.push({ avdName, serial, headless });
    return {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel_9_Pro_XL',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    };
  });
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android', target: 'tv', device: 'Pixel_9_Pro_XL' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
  expect(launchCalls).toEqual([{ avdName: 'Pixel_9_Pro_XL', serial: undefined, headless: false }]);
  if (response && !response.ok) {
    expect(response.error.code).toBe('DEVICE_NOT_FOUND');
    expect(response.error.message).toMatch(/matching --target tv/i);
  }
});

test('shutdown turns off selected iOS simulator', async () => {
  const sessionStore = makeSessionStore();
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
  expect(mockShutdownSimulator).toHaveBeenCalledWith(selectedDevice);
  if (response && response.ok) {
    expect(response.data?.platform).toBe('ios');
    expect(response.data?.id).toBe('sim-2');
    expect(response.data?.shutdown).toEqual({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  }
});

test('shutdown rejects active session device and points to close --shutdown', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  sessionStore.set(sessionName, makeSession(sessionName, selectedDevice));
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockShutdownSimulator).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('DEVICE_IN_USE');
    expect(response.error.message).toMatch(/close --shutdown/i);
    expect(response.error.details?.hint).toBe(
      'Run agent-device close --shutdown --session default',
    );
  }
});

test('shutdown turns off selected Android emulator', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel_9_Pro_XL',
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'android', device: 'Pixel_9_Pro_XL' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
  expect(mockRunCmd).toHaveBeenCalledWith(
    'adb',
    ['-s', 'emulator-5554', 'emu', 'kill'],
    expect.objectContaining({ allowFailure: true, timeoutMs: 15_000 }),
  );
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.shutdown).toEqual({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  }
});

test('shutdown rejects unsupported physical devices', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'device-1',
    name: 'iPhone',
    kind: 'device',
    target: 'mobile',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', udid: 'device-1' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockShutdownSimulator).not.toHaveBeenCalled();
  expect(mockRunCmd).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/Apple simulators and Android emulators/i);
  }
});

test('shutdown returns an error response when selected target shutdown fails', async () => {
  const sessionStore = makeSessionStore();
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);
  mockShutdownSimulator.mockResolvedValue({
    success: false,
    exitCode: 149,
    stdout: '',
    stderr: 'simctl shutdown failed',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toBe('simctl shutdown failed');
    expect(response.error.details?.shutdown).toEqual({
      success: false,
      exitCode: 149,
      stdout: '',
      stderr: 'simctl shutdown failed',
    });
  }
});

test('appstate on iOS requires active session on selected device', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 15',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.apple.Preferences',
    appName: 'Settings',
  });
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);
  mockDispatch.mockRejectedValue(new Error('snapshot dispatch should not run'));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'appstate',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/requires an active session/i);
  }
});

test('appstate returns session appName when bundle id is unavailable', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'sim';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appName: 'Maps',
  });

  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);
  mockDispatch.mockRejectedValue(new Error('snapshot dispatch should not run'));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'appstate',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.platform).toBe('ios');
    expect(response.data?.appName).toBe('Maps');
    expect(response.data?.appBundleId).toBe(undefined);
    expect(response.data?.source).toBe('session');
    expect(response.data?.device_udid).toBe('sim-1');
    expect(response.data?.ios_simulator_device_set).toBe(null);
  }
});

test('appstate fails when iOS session has no tracked app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'sim';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
  );

  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'appstate',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/no foreground app is tracked/i);
  }
});

test('appstate without session on iOS selector returns SESSION_NOT_FOUND', async () => {
  const sessionStore = makeSessionStore();
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'appstate',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
  }
});

test('appstate with explicit missing session returns SESSION_NOT_FOUND', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'sim',
      command: 'appstate',
      positionals: [],
      flags: { session: 'sim', platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'sim',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/no active session "sim"/i);
    expect(response.error.message).not.toMatch(/omit --session/i);
  }
});

test('clipboard requires an active session or explicit device selector', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'clipboard',
      positionals: ['read'],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(
      /clipboard requires an active session or an explicit device selector/i,
    );
  }
});

test('keyboard requires an active session or explicit device selector', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'keyboard',
      positionals: ['status'],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(
      /keyboard requires an active session or an explicit device selector/i,
    );
  }
});

test('keyboard dismiss requires active iOS session for explicit selectors', async () => {
  const sessionStore = makeSessionStore();

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'keyboard',
      positionals: ['dismiss'],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/requires an active session/i);
  }
});

test('clipboard rejects unsupported iOS physical devices', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
  );

  mockDispatch.mockRejectedValue(new Error('dispatch should not run for unsupported targets'));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'clipboard',
      positionals: ['read'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/clipboard is not supported on this device/i);
  }
});

test('perf requires an active session', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
  }
});

test('perf reports startup metric as unavailable when no sample exists', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-empty';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
  );

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    const startup = (response.data?.metrics as any)?.startup;
    const memory = (response.data?.metrics as any)?.memory;
    const cpu = (response.data?.metrics as any)?.cpu;
    expect(startup?.available).toBe(false);
    expect(String(startup?.reason ?? '')).toMatch(/no startup sample captured yet/i);
    expect(memory?.available).toBe(false);
    expect(String(memory?.reason ?? '')).toMatch(/run open <app> first/i);
    expect(cpu?.available).toBe(false);
    expect(String(cpu?.reason ?? '')).toMatch(/run open <app> first/i);
  }
});

test('perf preserves successful metrics and normalizes per-metric Android sampling failures', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-android-error';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
  });
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('meminfo')) {
      throw new AppError('COMMAND_FAILED', 'adb exited with code 1', {
        stderr: 'error: device offline',
        exitCode: 1,
        processExitError: true,
      });
    }
    return {
      stdout: '0.0% 1234/com.example.app: 0% user + 0% kernel',
      stderr: '',
      exitCode: 0,
    };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    const startup = (response.data?.metrics as any)?.startup;
    const memory = (response.data?.metrics as any)?.memory;
    const cpu = (response.data?.metrics as any)?.cpu;
    expect(startup?.available).toBe(false);
    expect(memory?.available).toBe(false);
    expect(memory?.reason).toBe('error: device offline');
    expect(memory?.error?.code).toBe('COMMAND_FAILED');
    expect(memory?.error?.hint).toMatch(/retry with --debug/i);
    expect(memory?.error?.details?.metric).toBe('memory');
    expect(memory?.error?.details?.package).toBe('com.example.app');
    expect(cpu?.available).toBe(true);
    expect(cpu?.usagePercent).toBe(0);
  }
});

test('perf samples Apple cpu and memory metrics on macOS app sessions', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-macos';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-mac',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    appBundleId: 'com.example.mac',
  });
  mockRunCmd.mockImplementation(async (cmd, _args) => {
    if (cmd === 'mdfind') {
      return { stdout: '/Applications/Example.app\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: 'ExampleExec\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'ps') {
      return {
        stdout: [
          '111 7.5 4096 /Applications/Example.app/Contents/MacOS/ExampleExec',
          '222 0.5 1024 /Applications/Example.app/Contents/MacOS/ExampleExec --flag',
          '333 5.0 2048 /Applications/Other.app/Contents/MacOS/OtherExec',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('Expected perf response to succeed for macOS session');
  const memory = (response.data?.metrics as any)?.memory;
  const cpu = (response.data?.metrics as any)?.cpu;
  expect(memory?.available).toBe(true);
  expect(memory?.residentMemoryKb).toBe(5120);
  expect(cpu?.available).toBe(true);
  expect(cpu?.usagePercent).toBe(8);
  expect(cpu?.matchedProcesses).toEqual(['ExampleExec']);
});

test('perf samples Apple cpu and memory metrics on iOS simulator app sessions', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-ios-sim';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.example.sim',
  });
  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'xcrun' && args.includes('get_app_container')) {
      return { stdout: '/tmp/Example.app\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: 'ExampleSimExec\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'xcrun' && args.includes('spawn') && args.includes('ps')) {
      return {
        stdout: ['111 11.0 6144 ExampleSimExec', '222 2.0 2048 SpringBoard'].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('Expected perf response to succeed for iOS simulator session');
  const memory = (response.data?.metrics as any)?.memory;
  const cpu = (response.data?.metrics as any)?.cpu;
  expect(memory?.available).toBe(true);
  expect(memory?.residentMemoryKb).toBe(6144);
  expect(cpu?.available).toBe(true);
  expect(cpu?.usagePercent).toBe(11);
  expect(cpu?.matchedProcesses).toEqual(['ExampleSimExec']);
});

test('perf samples Apple cpu and memory metrics on physical iOS devices', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-01T10:00:00.000Z'));
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-ios-device';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.device',
  });
  let exportCount = 0;
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (
      args[0] === 'devicectl' &&
      args[1] === 'device' &&
      args[2] === 'info' &&
      args[3] === 'apps'
    ) {
      const outputIndex = args.indexOf('--json-output');
      fs.writeFileSync(
        args[outputIndex + 1]!,
        JSON.stringify({
          result: {
            apps: [
              {
                bundleIdentifier: 'com.example.device',
                name: 'Example Device App',
                url: 'file:///private/var/containers/Bundle/Application/ABC123/ExampleDevice.app/',
              },
            ],
          },
        }),
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (
      args[0] === 'devicectl' &&
      args[1] === 'device' &&
      args[2] === 'info' &&
      args[3] === 'processes'
    ) {
      const outputIndex = args.indexOf('--json-output');
      fs.writeFileSync(
        args[outputIndex + 1]!,
        JSON.stringify({
          result: {
            runningProcesses: [
              {
                executable:
                  'file:///private/var/containers/Bundle/Application/ABC123/ExampleDevice.app/ExampleDeviceApp',
                processIdentifier: 4001,
              },
            ],
          },
        }),
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'xctrace' && args[1] === 'record') {
      vi.setSystemTime(new Date(Date.now() + 1000));
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'xctrace' && args[1] === 'export') {
      const outputIndex = args.indexOf('--output');
      exportCount += 1;
      await fs.promises.writeFile(
        args[outputIndex + 1]!,
        [
          '<?xml version="1.0"?>',
          '<trace-query-result>',
          '<node xpath="//trace-toc[1]/run[1]/data[1]/table[7]">',
          '<schema name="activity-monitor-process-live">',
          '<col><mnemonic>start</mnemonic></col>',
          '<col><mnemonic>process</mnemonic></col>',
          '<col><mnemonic>cpu-total</mnemonic></col>',
          '<col><mnemonic>memory-real</mnemonic></col>',
          '<col><mnemonic>pid</mnemonic></col>',
          '</schema>',
          '<row>',
          '<start-time fmt="00:00.123">123</start-time>',
          '<process fmt="ExampleDeviceApp (4001)"><pid fmt="4001">4001</pid></process>',
          exportCount === 1
            ? '<duration-on-core fmt="100.00 ms">100000000</duration-on-core>'
            : '<duration-on-core fmt="350.00 ms">350000000</duration-on-core>',
          '<size-in-bytes fmt="8.00 MiB">8388608</size-in-bytes>',
          '<pid fmt="4001">4001</pid>',
          '</row>',
          '</node>',
          '</trace-query-result>',
        ].join(''),
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('Expected perf response to succeed for physical iOS session');
  const memory = (response.data?.metrics as any)?.memory;
  const cpu = (response.data?.metrics as any)?.cpu;
  expect(memory?.available).toBe(true);
  expect(memory?.residentMemoryKb).toBe(8192);
  expect(cpu?.available).toBe(true);
  expect(cpu?.usagePercent).toBe(25);
  expect(cpu?.matchedProcesses).toEqual(['ExampleDeviceApp']);
});

test('perf reports physical iOS cpu and memory as unavailable without an app bundle id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-ios-device-no-bundle';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-2',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) {
    throw new Error('Expected perf response to succeed for physical iOS session without bundle id');
  }
  const memory = (response.data?.metrics as any)?.memory;
  const cpu = (response.data?.metrics as any)?.cpu;
  expect(memory?.available).toBe(false);
  expect(memory?.reason).toMatch(/no apple app bundle id is associated with this session/i);
  expect(cpu?.available).toBe(false);
  expect(cpu?.reason).toMatch(/no apple app bundle id is associated with this session/i);
});

test('open URL on existing iOS session clears stale app bundle id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 15',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
  });

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 15',
    kind: 'simulator',
    booted: true,
  });
  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['https://example.com/path'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe(undefined);
  expect(updated?.appName).toBe('https://example.com/path');
  expect(dispatchedContext?.appBundleId).toBe(undefined);
});

test('open URL on existing macOS session clears stale app bundle id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-mac',
      name: 'Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['https://example.com/path'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe(undefined);
  expect(updated?.appName).toBe('https://example.com/path');
  expect(dispatchedContext?.appBundleId).toBe(undefined);
});

test('open URL on existing iOS device session preserves app bundle id context', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    appName: 'Example App',
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['myapp://item/42'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.example.app');
  expect(updated?.appName).toBe('myapp://item/42');
  expect(dispatchedContext?.appBundleId).toBe('com.example.app');
});

test('open custom URL on existing iOS simulator session preserves app bundle id context', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    appName: 'Example App',
  });
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['myapp://item/42'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockEnsureDeviceReady.mock.calls[0]?.[1]).toEqual({
    deviceHub: false,
    onIosSimulatorColdBootStart: undefined,
  });
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.example.app');
  expect(updated?.appName).toBe('myapp://item/42');
  expect(dispatchedContext?.appBundleId).toBe('com.example.app');
});

test('open custom URL on fresh iOS simulator session infers app bundle id from URL scheme', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-url-session';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });
  mockResolveIosSimulatorDeepLinkBundleId.mockResolvedValue('org.reactnavigation.playground');

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['rne://navigator-layout'],
      flags: { platform: 'ios', udid: 'sim-1' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockResolveIosSimulatorDeepLinkBundleId).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'sim-1', kind: 'simulator' }),
    'rne://navigator-layout',
  );
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('org.reactnavigation.playground');
  expect(updated?.appName).toBe('rne://navigator-layout');
  expect(dispatchedContext?.appBundleId).toBe('org.reactnavigation.playground');
  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledTimes(1);
});

test('open iOS simulator app prewarms runner cache during cold boot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-cold-boot-cache-prewarm';
  const device: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: false,
  };
  mockResolveTargetDevice.mockResolvedValue(device);
  mockResolveIosApp.mockResolvedValueOnce('com.example.app');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'ios', udid: 'sim-1' },
      meta: { requestId: 'open-request' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const onColdBootStart = mockEnsureDeviceReady.mock.calls[0]?.[1]?.onIosSimulatorColdBootStart;
  expect(onColdBootStart).toBeTypeOf('function');
  onColdBootStart?.(device);
  expect(mockPrewarmAppleRunnerCache).toHaveBeenCalledWith(
    device,
    expect.objectContaining({
      logPath: expect.stringMatching(/daemon\.log$/),
      requestId: 'open-request',
    }),
  );
  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledTimes(1);
});

test('open iOS app session prewarms runner session when app bundle id is known', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.previous',
    appName: 'Previous App',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Settings', 'myapp://screen/to'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledTimes(1);
  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'ios-device-1' }),
    expect.objectContaining({ logPath: expect.stringMatching(/daemon\.log$/) }),
  );
});

test('open iOS Maestro app link waits for runner prewarm before launching app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-maestro-open-link';
  const events: string[] = [];
  let finishPrewarm: (() => void) | undefined;
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.previous',
    appName: 'Previous App',
  });

  mockPrewarmIosRunnerSession.mockImplementation(
    () =>
      new Promise((resolve) => {
        events.push('prewarm-start');
        finishPrewarm = () => {
          events.push('prewarm-finish');
          resolve();
        };
      }),
  );
  mockDispatch.mockImplementation(async (_device, command) => {
    events.push(`dispatch:${command}`);
    return {};
  });

  const responsePromise = handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['com.example.app', 'rne://screen-layout'],
      flags: {
        maestro: { prewarmRunnerBeforeOpen: true },
      },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  await vi.waitFor(() => expect(events).toEqual(['prewarm-start']));

  finishPrewarm?.();
  const response = await responsePromise;

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(events).toEqual(['prewarm-start', 'prewarm-finish', 'dispatch:open']);
  expect((response as any).data?.timing).toMatchObject({
    runnerPrewarmKind: 'session',
    runnerPrewarmScheduled: true,
    runnerPrewarmWaited: true,
  });
});

test('open iOS Maestro app link reports blocking runner prewarm failures before launching app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-maestro-open-link-prewarm-failed';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.previous',
    appName: 'Previous App',
  });
  mockPrewarmIosRunnerSession.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'Developer mode is disabled for Apple development tools', {
      hint: 'Run `sudo DevToolsSecurity -enable`.',
    }),
  );

  await expect(
    handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'open',
        positionals: ['com.example.app', 'rne://screen-layout'],
        flags: {
          maestro: { prewarmRunnerBeforeOpen: true },
        },
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Developer mode is disabled for Apple development tools',
    details: {
      hint: expect.stringContaining('DevToolsSecurity -enable'),
    },
  });
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'ios-device-1' }),
    expect.objectContaining({ propagateError: true }),
  );
});

test('open iOS URL without app bundle id skips runner prewarm', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
  );

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['myapp://screen/to'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockPrewarmIosRunnerSession).not.toHaveBeenCalled();
});

test('prepare ios-runner starts the XCTest runner on an explicit iOS selector', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'prepare-ios-runner';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'prepare',
      positionals: ['ios-runner'],
      flags: { platform: 'ios', udid: 'sim-1', timeoutMs: 240000 },
      meta: { requestId: 'prepare-request' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockEnsureDeviceReady).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'sim-1' }),
  );
  expect(mockPrepareIosRunner).toHaveBeenCalledTimes(1);
  expect(mockPrepareIosRunner).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'sim-1' }),
    expect.objectContaining({
      cleanStaleBundles: true,
      buildTimeoutMs: 240000,
      healthTimeoutMs: 240000,
      logPath: expect.stringMatching(/daemon\.log$/),
      prepareDeadline: expect.objectContaining({
        elapsedMs: expect.any(Function),
        isExpired: expect.any(Function),
        remainingMs: expect.any(Function),
      }),
      requestId: 'prepare-request',
      startupTimeoutMs: 240000,
    }),
  );
  expect((response as any).data).toMatchObject({
    action: 'ios-runner',
    platform: 'ios',
    deviceId: 'sim-1',
    deviceName: 'iPhone 17 Pro',
    kind: 'simulator',
    connectMs: 3,
    healthCheckMs: 3,
    runner: { currentUptimeMs: 42 },
    message: 'Prepared Apple runner: iPhone 17 Pro',
  });
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('prepare ios-runner starts the XCTest runner on an explicit macOS selector', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'prepare-macos-runner';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    appleOs: 'macos',
    id: 'host-macos-local',
    name: 'Host Mac',
    kind: 'device',
    target: 'desktop',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'prepare',
      positionals: ['ios-runner'],
      flags: { platform: 'macos', timeoutMs: 240000 },
      meta: { requestId: 'prepare-macos-request' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockPrepareIosRunner).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'host-macos-local' }),
    expect.objectContaining({
      buildTimeoutMs: 240000,
      healthTimeoutMs: 240000,
      prepareDeadline: expect.objectContaining({
        elapsedMs: expect.any(Function),
        isExpired: expect.any(Function),
        remainingMs: expect.any(Function),
      }),
      requestId: 'prepare-macos-request',
    }),
  );
  expect((response as any).data).toMatchObject({
    action: 'ios-runner',
    platform: 'macos',
    deviceId: 'host-macos-local',
    deviceName: 'Host Mac',
    kind: 'device',
    message: 'Prepared Apple runner: Host Mac',
  });
});

test('prepare ios-runner rejects non-Apple runner devices', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel 9 Pro XL',
    kind: 'emulator',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'prepare-android',
      command: 'prepare',
      positionals: ['ios-runner'],
      flags: { platform: 'android', serial: 'emulator-5554' },
    },
    sessionName: 'prepare-android',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toBe(
      'prepare ios-runner is only supported on Apple runner platforms',
    );
  }
  expect(mockPrepareIosRunner).not.toHaveBeenCalled();
});

test('prepare requires the ios-runner subcommand', async () => {
  const sessionStore = makeSessionStore();

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'prepare-invalid',
      command: 'prepare',
      positionals: [],
      flags: { platform: 'ios' },
    },
    sessionName: 'prepare-invalid',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe('prepare requires a subcommand: ios-runner');
  }
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
  expect(mockPrepareIosRunner).not.toHaveBeenCalled();
});

test('open web URL on iOS device session without active app falls back to Safari', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
  );

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['https://example.com/path'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.apple.mobilesafari');
  expect(updated?.appName).toBe('https://example.com/path');
  expect(dispatchedContext?.appBundleId).toBe('com.apple.mobilesafari');
});

test('open app and URL on existing iOS device session keeps app context', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.previous',
    appName: 'Previous App',
  });

  let dispatchedPositionals: string[] | undefined;
  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, positionals, _out, context) => {
    dispatchedPositionals = positionals;
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Settings', 'myapp://screen/to'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.apple.Preferences');
  expect(updated?.appName).toBe('Settings');
  expect(dispatchedPositionals).toEqual(['Settings', 'myapp://screen/to']);
  expect(dispatchedContext?.appBundleId).toBe('com.apple.Preferences');
});

test('open app on existing macOS session resolves and stores bundle id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-mac',
      name: 'Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['settings'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.apple.systempreferences');
  expect(updated?.appName).toBe('settings');
  expect(dispatchedContext?.appBundleId).toBe('com.apple.systempreferences');
});

test('open rejects --surface on non-macOS devices', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'ios-surface',
      command: 'open',
      positionals: ['Notes'],
      flags: {
        platform: 'ios',
        surface: 'frontmost-app',
      },
    },
    sessionName: 'ios-surface',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(response, 'surface is only supported on macOS and Linux');
});

test('open on existing macOS frontmost-app session preserves surface without --surface flag', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-frontmost-existing';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-macos-local',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    surface: 'frontmost-app',
    appBundleId: 'com.apple.TextEdit',
    appName: 'TextEdit',
  });

  const prevHelper = process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
  process.env.AGENT_DEVICE_MACOS_HELPER_BIN = '/usr/bin/true';
  mockRunCmd.mockResolvedValue({
    stdout: '{"ok":true,"data":{"bundleId":"com.apple.TextEdit","appName":"TextEdit","pid":123}}',
    stderr: '',
    exitCode: 0,
  });
  mockDispatch.mockImplementation(async (_device, _command, positionals) => {
    expect(positionals).toEqual([]);
    return {};
  });

  try {
    const response = await handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'open',
        positionals: [],
        flags: {
          platform: 'macos',
        },
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    });

    expect(response?.ok).toBe(true);
    const session = sessionStore.get(sessionName);
    expect(session?.surface).toBe('frontmost-app');
    expect(session?.appBundleId).toBe('com.apple.TextEdit');
    expect(session?.appName).toBe('TextEdit');
    if (response && response.ok) {
      expect(response.data?.surface).toBe('frontmost-app');
    }
  } finally {
    if (prevHelper === undefined) delete process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
    else process.env.AGENT_DEVICE_MACOS_HELPER_BIN = prevHelper;
  }
});

test('open on existing iOS session refreshes unavailable simulator by name', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'stale-sim',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: false,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
  });

  const resolvedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'fresh-sim',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  const selectors: Array<Record<string, unknown>> = [];
  let dispatchedDeviceId: string | undefined;

  mockResolveTargetDevice.mockImplementation(async (selector) => {
    selectors.push({ ...selector });
    if ((selector as any).udid === 'stale-sim') {
      throw new AppError('DEVICE_NOT_FOUND', 'not found');
    }
    return resolvedDevice;
  });
  mockDispatch.mockImplementation(async (device) => {
    dispatchedDeviceId = device.id;
    return {};
  });

  const response = await withMockedPlatform('darwin', async () =>
    handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'open',
        positionals: ['settings'],
        flags: {},
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  );

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(selectors.length).toBe(2);
  expect(selectors[0]).toEqual({ platform: 'ios', target: undefined, udid: 'stale-sim' });
  expect(selectors[1]).toEqual({ platform: 'ios', target: undefined, device: 'iPhone 17 Pro' });
  expect(dispatchedDeviceId).toBe('fresh-sim');
  const updated = sessionStore.get(sessionName);
  expect(updated?.device.id).toBe('fresh-sim');
  if (response && response.ok) {
    expect(response.data?.device_udid).toBe('fresh-sim');
  }
});

test('open app on existing Android session resolves and stores package id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
    appName: 'Old App',
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });
  mockResolveAndroidPackage.mockResolvedValue('org.reactjs.native.example.RNCLI83');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['RNCLI83'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('org.reactjs.native.example.RNCLI83');
  expect(updated?.appName).toBe('RNCLI83');
  expect(dispatchedContext?.appBundleId).toBe('org.reactjs.native.example.RNCLI83');
});

test('open intent target on existing Android session clears stale package context', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });
  mockResolveAndroidPackage.mockResolvedValue(undefined);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['settings'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe(undefined);
  expect(updated?.appName).toBe('settings');
  expect(dispatchedContext?.appBundleId).toBe(undefined);
});

test('open on existing Android session preserves a comparable freshness baseline', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-open-freshness';
  const baselineNodes = Array.from({ length: 14 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Inbox row ${index + 1}`,
  }));
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
    snapshot: {
      nodes: baselineNodes,
      createdAt: Date.now(),
      backend: 'android',
      comparisonSafe: true,
    },
  });

  mockDispatch.mockResolvedValue({});
  mockResolveAndroidPackage.mockResolvedValue('com.android.settings');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['settings'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.snapshot).toBeUndefined();
  expect(updated?.androidSnapshotFreshness).toEqual({
    action: 'open',
    markedAt: expect.any(Number),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  });
});

test('open --relaunch closes and reopens active session app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const calls: Array<{ command: string; positionals: string[] }> = [];
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push({ command, positionals });
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls.length).toBe(2);
  expect(calls[0]).toEqual({ command: 'close', positionals: ['com.example.app'] });
  expect(calls[1]).toEqual({ command: 'open', positionals: ['com.example.app'] });
});

test('open --relaunch on iOS stops runner before close/open', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'My iPhone',
      kind: 'device',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const calls: string[] = [];
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'ios-device-1',
    name: 'My iPhone',
    kind: 'device',
    booted: true,
  });
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual(['stop-runner', 'close:com.example.app', 'open:com.example.app']);
});

test('open --relaunch on iOS simulator stops runner before close/open', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const calls: string[] = [];
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual(['stop-runner', 'close:com.example.app', 'open:com.example.app']);
});

test('open --relaunch includes timing and waits for iOS runner prewarm after opening app', async () => {
  vi.useFakeTimers({ now: 1_000 });
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-timing-session';
  const events: string[] = [];
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'My iPhone',
      kind: 'device',
      booted: true,
    }),
    appName: 'Example',
    appBundleId: 'com.example.app',
  });

  mockPrewarmIosRunnerSession.mockImplementation(
    () =>
      new Promise((resolve) => {
        events.push('prewarm-start');
        setTimeout(() => {
          events.push('prewarm-finish');
          resolve();
        }, 250);
      }),
  );
  mockStopIosRunner.mockImplementation(async () => {
    events.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command) => {
    events.push(`dispatch:${command}`);
    return {};
  });

  const responsePromise = handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  await vi.advanceTimersByTimeAsync(250);
  const response = await responsePromise;

  expect(response?.ok).toBe(true);
  expect(events).toEqual([
    'stop-runner',
    'dispatch:close',
    'dispatch:open',
    'prewarm-start',
    'prewarm-finish',
  ]);
  expect((response as any).data?.timing).toMatchObject({
    runnerPrewarmKind: 'session',
    runnerPrewarmScheduled: true,
    runnerPrewarmWaited: true,
    runnerPrewarmDurationMs: 250,
  });
  expect((response as any).data?.timing?.totalDurationMs).toBeGreaterThanOrEqual(250);
});

test('open --relaunch on iOS without existing session closes then opens target app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-new-session';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'ios-device-1',
    name: 'My iPhone',
    kind: 'device',
    booted: true,
  });

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['com.example.app'],
      flags: { relaunch: true, platform: 'ios' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual(['stop-runner', 'close:com.example.app', 'open:com.example.app']);
});

test('open --relaunch on iOS simulator reaches settle path for close and open', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 16',
      kind: 'simulator',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 16',
    kind: 'simulator',
    booted: true,
  });
  const settleCalls: Array<{ deviceId: string; delayMs: number }> = [];
  mockSettleSimulator.mockImplementation(async (device, delayMs) => {
    settleCalls.push({ deviceId: device.id, delayMs });
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(settleCalls.length).toBe(2);
  expect(settleCalls[0]).toEqual({ deviceId: 'sim-1', delayMs: 300 });
  expect(settleCalls[1]).toEqual({ deviceId: 'sim-1', delayMs: 300 });
});

test('close on macOS session stops runner and dismisses automation alert before delete', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-macos-local',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    appBundleId: 'com.apple.systempreferences',
    appName: 'System Settings',
  });

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async (deviceId) => {
    calls.push(`stop-runner:${deviceId}`);
  });
  mockDismissMacOsAlert.mockImplementation(async (action, options) => {
    calls.push(
      `dismiss-alert:${action}:${(options as any)?.bundleId ?? (options as any)?.surface ?? 'frontmost'}`,
    );
    return {};
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

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual([
    'stop-runner:host-macos-local',
    'dismiss-alert:dismiss:com.apple.systempreferences',
  ]);
  expect(sessionStore.get(sessionName)).toBe(undefined);
});

test('close <app> on iOS stops runner before app close dispatch and performs final idempotent stop', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-close-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'My iPhone',
      kind: 'device',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual(['stop-runner', 'close:com.example.app', 'stop-runner']);
});

test('close <app> on iOS simulator retains runner while terminating app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-close-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual(['close:com.example.app']);
});

test('close <app> on macOS stops runner before app close dispatch and dismisses automation alert', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-close-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-macos-local',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    appBundleId: 'com.apple.systempreferences',
    appName: 'System Settings',
  });

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async (deviceId) => {
    calls.push(`stop-runner:${deviceId}`);
  });
  mockDismissMacOsAlert.mockImplementation(async (action, options) => {
    calls.push(
      `dismiss-alert:${action}:${(options as any)?.bundleId ?? (options as any)?.surface ?? 'frontmost'}`,
    );
    return {};
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['System Settings'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual([
    'stop-runner:host-macos-local',
    'dismiss-alert:dismiss:com.apple.systempreferences',
    'close:System Settings',
    'stop-runner:host-macos-local',
    'dismiss-alert:dismiss:com.apple.systempreferences',
  ]);
});

test('open --relaunch rejects URL targets', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['https://example.com/path'],
      flags: { relaunch: true },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/does not support URL targets/i);
  }
});

test('open --relaunch fails without app when no session exists', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/requires an app argument/i);
  }
});

test('open --relaunch rejects Android app binary paths', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['/tmp/app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Android runtime hints require an installed package name, not "/tmp/app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
});

test('open --relaunch rejects bare Android app binary filenames', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Android runtime hints require an installed package name, not "app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
});

test('open --relaunch rejects Android app binary paths for active sessions', async () => {
  const sessionStore = makeSessionStore();
  const session = makeSession('default', {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  session.appName = 'com.example.app';
  session.appBundleId = 'com.example.app';
  sessionStore.set('default', session);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['/tmp/app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Android runtime hints require an installed package name, not "/tmp/app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
});

test('open --relaunch rejects Android app binary paths for active sessions before device refresh', async () => {
  const sessionStore = makeSessionStore();
  const session = makeSession('default', {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  session.appName = 'com.example.app';
  session.appBundleId = 'com.example.app';
  sessionStore.set('default', session);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['/tmp/app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Android runtime hints require an installed package name, not "/tmp/app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
});

test('open --relaunch rejects Android app binary paths before resolving a new device', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['/tmp/app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Android runtime hints require an installed package name, not "/tmp/app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
});

test('open on in-use device returns DEVICE_IN_USE before readiness checks', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.set(
    'busy-session',
    makeSession('busy-session', {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
  );

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['settings'],
      flags: { platform: 'ios' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('DEVICE_IN_USE');
    expect(response.error.details?.hint).toContain('agent-device session list');
    expect(response.error.details?.hint).toContain('--session busy-session');
    expect(response.error.details?.hint).toContain('agent-device close --session busy-session');
  }
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
});

test('open on device owned by recording session returns recording recovery hint', async () => {
  const sessionStore = makeSessionStore();
  const recordingSession = makeSession('default', {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  });
  recordingSession.recordOnlySession = true;
  recordingSession.recording = {
    platform: 'ios',
    child: { kill: vi.fn(), pid: 123 },
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    outPath: '/tmp/recording.mp4',
    startedAt: Date.now(),
    showTouches: false,
    gestureEvents: [],
  };
  sessionStore.set('default', recordingSession);

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'test-attempt',
      command: 'open',
      positionals: ['settings'],
      flags: { platform: 'ios' },
    },
    sessionName: 'test-attempt',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('DEVICE_IN_USE');
    expect(response.error.details?.hint).toContain('Recording session "default" owns this device');
    expect(response.error.details?.hint).toContain('agent-device record stop --session default');
    expect(response.error.details?.hint).toContain('agent-device close --session default');
    expect(response.error.details?.hint).toContain('agent-device session list');
  }
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
});

test('replay parses open --relaunch flag and replays open with relaunch semantics', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-relaunch-'));
  const replayPath = path.join(replayRoot, 'relaunch.ad');
  fs.writeFileSync(replayPath, 'open "Settings" --relaunch\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.replayed).toBe(1);
  }
  expect(invoked.length).toBe(1);
  expect(invoked[0]?.command).toBe('open');
  expect(invoked[0]?.positionals).toEqual(['Settings']);
  expect(invoked[0]?.flags?.relaunch).toBe(true);
});

test('replay parses runtime set flags and replays runtime command', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-runtime-'));
  const replayPath = path.join(replayRoot, 'runtime.ad');
  fs.writeFileSync(
    replayPath,
    'runtime set --platform android --metro-host 10.0.0.10 --metro-port 8081 --launch-url "myapp://dev"\n',
  );
  const invoked: DaemonRequest[] = [];

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      flags: {},
      meta: { cwd: replayRoot },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (request) => {
      invoked.push(request);
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBe(true);
  expect(invoked[0]?.command).toBe('runtime');
  expect(invoked[0]?.positionals).toEqual(['set']);
  expect(invoked[0]?.flags).toEqual({
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
    launchUrl: 'myapp://dev',
  });
});

test('replay parses inline open runtime flags and replays open with runtime payload', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-open-runtime-'));
  const replayPath = path.join(replayRoot, 'runtime-open.ad');
  fs.writeFileSync(
    replayPath,
    'open "Demo" --relaunch --platform android --metro-host 10.0.0.10 --metro-port 8081 --launch-url "myapp://dev"\n',
  );
  const invoked: DaemonRequest[] = [];

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      flags: {},
      meta: { cwd: replayRoot },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (request) => {
      invoked.push(request);
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBe(true);
  expect(invoked[0]?.command).toBe('open');
  expect(invoked[0]?.positionals).toEqual(['Demo']);
  expect(invoked[0]?.flags).toEqual({ relaunch: true });
  expect(invoked[0]?.runtime).toEqual({
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
    launchUrl: 'myapp://dev',
  });
});

test('replay resolves relative script path against request cwd', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-cwd-'));
  const replayDir = path.join(replayRoot, 'workflows');
  fs.mkdirSync(replayDir, { recursive: true });
  fs.writeFileSync(path.join(replayDir, 'flow.ad'), 'open "Settings"\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: ['workflows/flow.ad'],
      flags: {},
      meta: { cwd: replayRoot },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(invoked.length).toBe(1);
  expect(invoked[0]?.command).toBe('open');
  expect(invoked[0]?.positionals).toEqual(['Settings']);
});

test('replay inherits parent device selectors for each invoked step', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-parent-selectors-'),
  );
  const replayPath = path.join(replayRoot, 'selectors.ad');
  fs.writeFileSync(replayPath, 'open "com.whoop.iphone"\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      flags: {
        platform: 'ios',
        device: 'thymikee-iphone',
        udid: '00008150-001849640CF8401C',
      },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(invoked.length).toBe(1);
  expect(invoked[0]?.flags?.platform).toBe('ios');
  expect(invoked[0]?.flags?.device).toBe('thymikee-iphone');
  expect(invoked[0]?.flags?.udid).toBe('00008150-001849640CF8401C');
});

test('logs requires an active session', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'logs',
      positionals: ['path'],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
  }
});

test('logs rejects invalid action', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.set(
    'default',
    makeSession('default', {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone',
      kind: 'simulator',
      booted: true,
    }),
  );
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'logs',
      positionals: ['invalid'],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/path, start, stop, doctor, mark, or clear/);
  }
});

test('logs start requires app session (appBundleId)', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.set(
    'default',
    makeSession('default', {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone',
      kind: 'simulator',
      booted: true,
    }),
  );
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'logs',
      positionals: ['start'],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/app session|open first/i);
  }
});

test('logs stop requires active app log stream', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.set(
    'default',
    makeSession('default', {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone',
      kind: 'simulator',
      booted: true,
    }),
  );
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'logs',
      positionals: ['stop'],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/no app log stream/i);
  }
});

test('logs clear requires stream to be stopped first', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    appLog: {
      platform: 'android',
      backend: 'android',
      outPath: '/tmp/app.log',
      startedAt: Date.now(),
      getState: () => 'active',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'logs',
      positionals: ['clear'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/logs stop/i);
  }
});

test('logs --restart is only supported with logs clear', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone Simulator',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
  });
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'logs',
      positionals: ['path'],
      flags: { restart: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/only supported with logs clear/i);
  }
});

test('logs clear --restart requires app session bundle id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'logs',
      positionals: ['clear'],
      flags: { restart: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/app session|open <app>/i);
  }
});

test('network requires an active session', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'network',
      positionals: ['dump'],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
  }
});

test('network dump adds a targeted note when the session app log stream is inactive', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-network-inactive';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    appLog: {
      platform: 'android',
      backend: 'android',
      outPath: '/tmp/app.log',
      startedAt: Date.now(),
      getState: () => 'failed',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.active).toBe(true);
    expect(response.data?.state).toBe('failed');
    expect(response.data?.notes).toContain(
      'Session app log stream is inactive. Run logs clear --restart, reproduce the request window again, then rerun network dump.',
    );
  }
});

test('network dump recovers Android entries from adb logcat when the session stream is inactive', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-network-recovery';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    appLog: {
      platform: 'android',
      backend: 'android',
      outPath: '/tmp/app.log',
      startedAt: Date.now(),
      getState: () => 'failed',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.join(' ') === '-s emulator-5554 shell pidof com.example.app') {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (args.join(' ') === '-s emulator-5554 logcat -d -v time -t 4000') {
      return {
        stdout:
          '04-01 10:00:14.500 I/ActivityManager( 9999): Start proc 4321:com.example.app/u0a123 for top-activity\n' +
          '04-01 10:00:15.000 D/GIBSDK  (4321): POST https://api.example.com/v1/documents status=200 duration=15032\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.path).toContain('adb logcat recovery');
    expect(response.data?.state).toBe('failed');
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(1);
    const latest = entries[0] as Record<string, unknown>;
    expect(latest.method).toBe('POST');
    expect(latest.url).toBe('https://api.example.com/v1/documents');
    expect(latest.status).toBe(200);
    expect(response.data?.notes).toContain(
      'Session app log stream was inactive. Recovered recent Android HTTP entries from adb logcat for PID set 4321.',
    );
  }
});

test('network dump merges Android recovery entries ahead of stale session log traffic', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-network-merge';
  const appLogPath = sessionStore.resolveAppLogPath(sessionName);
  fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  fs.writeFileSync(
    appLogPath,
    '2026-04-01T09:59:00Z GET https://api.example.com/v1/stale status=200\n',
    'utf8',
  );
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    appLog: {
      platform: 'android',
      backend: 'android',
      outPath: appLogPath,
      startedAt: Date.now(),
      getState: () => 'failed',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.join(' ') === '-s emulator-5554 shell pidof com.example.app') {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (args.join(' ') === '-s emulator-5554 logcat -d -v time -t 4000') {
      return {
        stdout:
          '04-01 10:00:14.500 I/ActivityManager( 9999): Start proc 4321:com.example.app/u0a123 for top-activity\n' +
          '04-01 10:00:15.000 D/GIBSDK  (4321): POST https://api.example.com/v1/fresh status=201 duration=15032\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(2);
    expect((entries[0] as Record<string, unknown>).url).toBe('https://api.example.com/v1/fresh');
    expect((entries[1] as Record<string, unknown>).url).toBe('https://api.example.com/v1/stale');
  }
});

test('network dump recovers Android entries from previous package pid in bounded logcat window', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-network-previous-pid';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    appLog: {
      platform: 'android',
      backend: 'android',
      outPath: '/tmp/app.log',
      startedAt: Date.now(),
      getState: () => 'failed',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.join(' ') === '-s emulator-5554 shell pidof com.example.app') {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (args.join(' ') === '-s emulator-5554 logcat -d -v time -t 4000') {
      return {
        stdout:
          '04-01 10:00:00.000 I/ActivityManager( 9999): Process com.example.app (pid 1234) has died\n' +
          '04-01 10:00:00.500 D/GIBSDK  (1234): POST https://api.example.com/v1/submit status=504 duration=15000\n' +
          '04-01 10:00:01.000 I/ActivityManager( 9999): Start proc 4321:com.example.app/u0a123 for top-activity\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(1);
    expect((entries[0] as Record<string, unknown>).url).toBe('https://api.example.com/v1/submit');
    expect(response.data?.notes).toContain(
      'Session app log stream was inactive. Recovered recent Android HTTP entries from adb logcat for PID set 4321, 1234.',
    );
  }
});

test('network dump recovers Android entries when an active stream is still bound to a prior pid', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-network-stale-active-pid';
  const appLogPath = sessionStore.resolveAppLogPath(sessionName);
  const appLogPidPath = sessionStore.resolveAppLogPidPath(sessionName);
  fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  fs.writeFileSync(
    appLogPath,
    '2026-04-01T09:59:00Z GET https://api.example.com/v1/stale status=200\n',
    'utf8',
  );
  fs.writeFileSync(
    appLogPidPath,
    `${JSON.stringify({
      pid: 9999,
      startTime: 'Tue Apr  1 09:59:00 2026',
      command: 'adb -s emulator-5554 logcat -v time --pid 1234',
    })}\n`,
    'utf8',
  );
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    appLog: {
      platform: 'android',
      backend: 'android',
      outPath: appLogPath,
      startedAt: Date.now(),
      getState: () => 'active',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.join(' ') === '-s emulator-5554 shell pidof com.example.app') {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (args.join(' ') === '-s emulator-5554 logcat -d -v time -t 4000') {
      return {
        stdout:
          '04-01 10:00:14.500 I/ActivityManager( 9999): Start proc 4321:com.example.app/u0a123 for top-activity\n' +
          '04-01 10:00:15.000 D/GIBSDK  (4321): POST https://api.example.com/v1/fresh status=201 duration=15032\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.path).toContain('adb logcat recovery');
    expect(response.data?.state).toBe('active');
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(2);
    expect((entries[0] as Record<string, unknown>).url).toBe('https://api.example.com/v1/fresh');
    expect((entries[1] as Record<string, unknown>).url).toBe('https://api.example.com/v1/stale');
    expect(response.data?.notes).toContain(
      'Session app log stream was still bound to prior Android PID 1234. Recovered recent Android HTTP entries from adb logcat for PID set 4321.',
    );
  }
});

test('network dump recovers iOS simulator entries from simctl log show when the live stream is empty', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-network-recovery';
  const appLogPath = sessionStore.resolveAppLogPath(sessionName);
  fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  fs.writeFileSync(
    appLogPath,
    'Filtering the log data using "subsystem == \\"com.agentdevice.tester\\""\n',
    'utf8',
  );
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.agentdevice.tester',
    appLog: {
      platform: 'apple',
      backend: 'ios-simulator',
      outPath: appLogPath,
      startedAt: 1_712_040_000_000,
      getState: () => 'active',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (
      args[0] === 'simctl' &&
      args[1] === 'spawn' &&
      args[2] === 'sim-1' &&
      args[3] === 'log' &&
      args[4] === 'show'
    ) {
      return {
        stdout:
          'Timestamp               Ty Process[PID:TID]\n' +
          '2026-04-02 08:08:50.665 I Agent Device Tester[32193:8c7411e] POST https://api.example.com/v1/search statusCode=200 duration=42\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.path).toContain('simctl log show recovery');
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(1);
    expect((entries[0] as Record<string, unknown>).url).toBe('https://api.example.com/v1/search');
    expect((entries[0] as Record<string, unknown>).status).toBe(200);
    expect((entries[0] as Record<string, unknown>).durationMs).toBe(42);
    expect(response.data?.notes).toContain(
      'Recovered 1 iOS simulator HTTP entry from simctl log show (1 app log lines scanned).',
    );
  }
});

test('network dump explains when iOS simulator recovery found app logs but no HTTP-shaped entries', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-network-no-http';
  const appLogPath = sessionStore.resolveAppLogPath(sessionName);
  fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  fs.writeFileSync(
    appLogPath,
    'Filtering the log data using "subsystem == \\"com.agentdevice.tester\\""\n',
    'utf8',
  );
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.agentdevice.tester',
    appLog: {
      platform: 'apple',
      backend: 'ios-simulator',
      outPath: appLogPath,
      startedAt: 1_712_040_000_000,
      getState: () => 'active',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (
      args[0] === 'simctl' &&
      args[1] === 'spawn' &&
      args[2] === 'sim-1' &&
      args[3] === 'log' &&
      args[4] === 'show'
    ) {
      return {
        stdout:
          'Timestamp               Ty Process[PID:TID]\n' +
          '2026-04-02 08:08:50.665 E Agent Device Tester[32193:8c7411e] Airship config warning\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(Array.isArray(response.data?.entries) ? response.data.entries : []).toHaveLength(0);
    expect(response.data?.notes).toContain(
      'Recovered 1 recent iOS simulator app log lines from simctl log show, but none looked like HTTP traffic. This app may not emit request URLs, status, or timing into Unified Logging for this repro window.',
    );
    expect(response.data?.notes).toContain(
      'No HTTP(s) entries were found in recent iOS simulator app logs. If the app only emits non-HTTP diagnostics, inspect logs path or add app-side URLSession/network logging for per-request timing and payload details.',
    );
  }
});

test('network dump supports macOS desktop sessions', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-network';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-macos-local',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    appBundleId: 'com.apple.systempreferences',
  });
  const appLogPath = sessionStore.resolveAppLogPath(sessionName);
  fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  fs.writeFileSync(
    appLogPath,
    '2026-02-24T10:00:00Z GET https://example.com/mac status=204',
    'utf8',
  );
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.backend).toBe('macos');
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(1);
    expect((entries[0] as Record<string, unknown>).url).toBe('https://example.com/mac');
  }
});

test('network dump validates include mode and limit', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );

  const invalidLimit = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '0'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(invalidLimit).toBeTruthy();
  expect(invalidLimit?.ok).toBe(false);
  if (invalidLimit && !invalidLimit.ok) {
    expect(invalidLimit.error.code).toBe('INVALID_ARGS');
    expect(invalidLimit.error.message).toMatch(/1\.\.200/);
  }

  const invalidMode = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'verbose'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(invalidMode).toBeTruthy();
  expect(invalidMode?.ok).toBe(false);
  if (invalidMode && !invalidMode.ok) {
    expect(invalidMode.error.code).toBe('INVALID_ARGS');
    expect(invalidMode.error.message).toMatch(/summary, headers, body, all/);
  }
});

test('session_list includes device_udid and ios_simulator_device_set for iOS sessions', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.set(
    'ios-scoped',
    makeSession('ios-scoped', {
      platform: 'apple',
      id: 'DEF-456',
      name: 'iPhone 16',
      kind: 'simulator',
      booted: true,
      simulatorSetPath: '/tmp/tenant-a/simulators',
    }),
  );
  sessionStore.set(
    'android-1',
    makeSession('android-1', {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
  );
  sessionStore.set(
    'macos-1',
    makeSession('macos-1', {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-macos-local',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
  );

  const response = await handleSessionCommands({
    req: { token: 't', session: 'default', command: 'session_list', positionals: [] },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    const sessions = response.data?.sessions as Array<Record<string, unknown>>;
    expect(Array.isArray(sessions)).toBeTruthy();
    const iosScoped = sessions.find((s) => s.name === 'ios-scoped');
    expect(iosScoped?.device_udid).toBe('DEF-456');
    expect(iosScoped?.ios_simulator_device_set).toBe('/tmp/tenant-a/simulators');
    const android = sessions.find((s) => s.name === 'android-1');
    const macos = sessions.find((s) => s.name === 'macos-1');
    expect(android?.device_udid).toBe(undefined);
    expect(android?.ios_simulator_device_set).toBe(undefined);
    expect(android?.device_id).toBe('emulator-5554');
    expect(macos?.device_id).toBe('host-macos-local');
    expect(macos?.device_udid).toBe(undefined);
    expect(macos?.ios_simulator_device_set).toBe(undefined);
  }
});

test('test filters replay scripts by context platform and skips untyped files', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-filter-'));
  fs.writeFileSync(path.join(root, '01-android.ad'), 'context platform=android\nopen "Demo"\n');
  fs.writeFileSync(path.join(root, '02-ios.ad'), 'context platform=ios\nopen "Settings"\n');
  fs.writeFileSync(path.join(root, '03-untyped.ad'), 'open "Calculator"\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      flags: { platform: 'android' },
      meta: { cwd: root, requestId: 'suite-filter' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBeTruthy();
  expect(invoked.length).toBe(1);
  expect(invoked[0]?.flags?.platform).toBe('android');
  expect(invoked[0]?.session).toBe('default:test:suite-filter:1-01-android:attempt-1');
  if (response?.ok) {
    expect(response.data?.passed).toBe(1);
    expect(response.data?.failed).toBe(0);
    expect(response.data?.skipped).toBe(1);
    const tests = response.data?.tests as Array<Record<string, unknown>> | undefined;
    expect(tests?.length).toBe(2);
    expect(tests?.[0]?.status).toBe('passed');
    expect(tests?.[1]?.status).toBe('skipped');
    expect(tests?.[1]?.reason).toBe('skipped-by-filter');
  }
});

test('test binds each replay script to its declared platform metadata', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-platforms-'));
  fs.writeFileSync(path.join(root, '01-android.ad'), 'context platform=android\nopen "Demo"\n');
  fs.writeFileSync(path.join(root, '02-ios.ad'), 'context platform=ios\nopen "Settings"\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-platforms' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBeTruthy();
  expect(invoked.map((req) => req.flags?.platform)).toEqual(['android', 'ios']);
  expect(invoked.map((req) => req.session)).toEqual([
    'default:test:suite-platforms:1-01-android:attempt-1',
    'default:test:suite-platforms:2-02-ios:attempt-1',
  ]);
  if (response?.ok) {
    expect(response.data?.passed).toBe(2);
    expect(response.data?.failed).toBe(0);
    expect(response.data?.skipped).toBe(0);
  }
});

test('test cleans up suite-owned sessions after each executed script', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-cleanup-'));
  fs.writeFileSync(path.join(root, '01-android.ad'), 'context platform=android\nopen "Demo"\n');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-cleanup' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      sessionStore.set(
        req.session,
        makeSession(req.session, {
          platform: 'android',
          id: 'emulator-5554',
          name: 'Pixel',
          kind: 'emulator',
          booted: true,
        }),
      );
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBeTruthy();
  expect(sessionStore.get('default:test:suite-cleanup:1-01-android:attempt-1')).toBe(undefined);
});

test('test retries failed scripts with fresh suite-owned sessions', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-retries-'));
  fs.writeFileSync(
    path.join(root, '01-retry.ad'),
    'context platform=android retries=9\nopen "Demo"\n',
  );

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-retries' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      if (invoked.length < 4) {
        return {
          ok: false,
          error: {
            code: 'ASSERTION_FAILED',
            message: 'expected selector to exist',
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBeTruthy();
  expect(invoked.map((req) => req.session)).toEqual([
    'default:test:suite-retries:1-01-retry:attempt-1',
    'default:test:suite-retries:1-01-retry:attempt-2',
    'default:test:suite-retries:1-01-retry:attempt-3',
    'default:test:suite-retries:1-01-retry:attempt-4',
  ]);
  if (response?.ok) {
    expect(response.data?.passed).toBe(1);
    expect(response.data?.failed).toBe(0);
    const tests = response.data?.tests as Array<Record<string, unknown>> | undefined;
    expect(tests?.[0]?.status).toBe('passed');
    expect(tests?.[0]?.attempts).toBe(4);
  }
});

test('test applies per-script timeout and writes attempt artifacts', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-timeout-'));
  const screenshotPath = path.join(root, 'capture.png');
  fs.writeFileSync(screenshotPath, 'screenshot');
  fs.writeFileSync(
    path.join(root, '01-timeout.ad'),
    'context platform=android timeout=10\nscreenshot "./capture.png"\nopen "Demo"\n',
  );

  let invocationCount = 0;
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-timeout' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (_req) => {
      invocationCount += 1;
      if (invocationCount === 1) {
        return { ok: true, data: { path: screenshotPath } };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBeTruthy();
  if (response?.ok) {
    expect(response.data?.failed).toBe(1);
    const tests = response.data?.tests as Array<Record<string, unknown>> | undefined;
    expect(tests?.[0]?.status).toBe('failed');
    expect(tests?.[0]?.attempts).toBe(1);
    const artifactsDir = tests?.[0]?.artifactsDir;
    expect(typeof artifactsDir).toBe('string');
    const attemptDir = path.join(artifactsDir as string, 'attempt-1');
    expect(fs.existsSync(path.join(attemptDir, 'replay.ad'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'capture.png'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'replay-timing.ndjson'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'result.txt'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'failure.txt'))).toBe(true);
    const timingLines = fs
      .readFileSync(path.join(attemptDir, 'replay-timing.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(timingLines.some((line) => line.type === 'replay_test_attempt_start')).toBe(true);
    expect(timingLines.some((line) => line.type === 'replay_action_start')).toBe(true);
    expect(
      timingLines.some(
        (line) => line.type === 'replay_test_attempt_stop' && line.timedOut === true,
      ),
    ).toBe(true);
    const resultText = fs.readFileSync(path.join(attemptDir, 'result.txt'), 'utf8');
    expect(resultText).toMatch(/status: failed/);
    expect(resultText).toMatch(/timeoutMode: cooperative/);
  }
});

test('open does not retain a session when the request was canceled before completion', async () => {
  const sessionStore = makeSessionStore();
  const requestId = 'open-canceled-before-store';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'ios',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  } as any);

  markRequestCanceled(requestId);
  try {
    const response = await handleSessionCommands({
      req: {
        token: 't',
        session: 'default',
        command: 'open',
        positionals: ['com.apple.Preferences'],
        flags: { platform: 'ios' },
        meta: { requestId },
      },
      sessionName: 'default',
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    });

    expect(response?.ok).toBe(false);
    if (response && !response.ok) {
      expect(response.error.code).toBe('COMMAND_FAILED');
      expect(response.error.message).toBe('request canceled');
    }
    expect(sessionStore.get('default')).toBeUndefined();
  } finally {
    clearRequestCanceled(requestId);
  }
});

test('test returns invalid args when no replay scripts match the platform filter', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-empty-filter-'));
  fs.writeFileSync(path.join(root, '01-ios.ad'), 'context platform=ios\nopen "Settings"\n');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      flags: { platform: 'android' },
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(response, 'No replay tests matched for --platform android.');
});

test('test rejects duplicate replay test metadata in the context header', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-metadata-'));
  fs.writeFileSync(
    path.join(root, '01-invalid.ad'),
    'context platform=ios timeout=1000\ncontext timeout=2000\nopen "Demo"\n',
  );

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Conflicting replay test metadata "timeoutMs" in context header: 1000 vs 2000.',
  );
});
