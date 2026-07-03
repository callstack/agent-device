import { isMacOs } from '../../../kernel/device.ts';
import { expect, vi, beforeEach } from 'vitest';
export { test } from 'vitest';
export { expect, vi };

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
    scheduleIosRunnerIdleStop: vi.fn(),
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
  return {
    ...actual,
    runAppLogDoctor: vi.fn(async () => ({ checks: {}, notes: [] })),
    startAppLog: vi.fn(),
    stopAppLog: vi.fn(async () => {}),
  };
});
vi.mock('../session-deploy.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-deploy.ts')>();
  return {
    ...actual,
    defaultInstallOps: { ios: vi.fn(), android: vi.fn() },
    defaultReinstallOps: { ios: vi.fn(), android: vi.fn() },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSnapshotSignatures } from '../../android-snapshot-freshness.ts';
import {
  retainMaterializedPaths,
  cleanupRetainedMaterializedPathsForSession,
} from '../../materialized-path-registry.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import { AppError } from '../../../kernel/errors.ts';
import {
  IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED,
  IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED_NOTE,
} from '../../app-log-ios.ts';
import { dispatchCommand, resolveTargetDevice } from '../../../core/dispatch.ts';
import { ensureDeviceReady } from '../../device-ready.ts';
import { applyRuntimeHintsToApp, clearRuntimeHintsFromApp } from '../../runtime-hints.ts';
import {
  prepareIosRunner,
  prewarmAppleRunnerCache,
  prewarmIosRunnerSession,
  scheduleIosRunnerIdleStop,
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
import { runAppLogDoctor, startAppLog, stopAppLog } from '../../app-log.ts';
import { defaultInstallOps, defaultReinstallOps } from '../session-deploy.ts';
import { clearRequestCanceled, markRequestCanceled } from '../../request-cancel.ts';

export {
  fs,
  os,
  path,
  buildSnapshotSignatures,
  retainMaterializedPaths,
  LeaseRegistry,
  SessionStore,
  AppError,
  IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED,
  IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED_NOTE,
  clearRequestCanceled,
  markRequestCanceled,
};

export const mockDispatch = vi.mocked(dispatchCommand);
export const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
export const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);
export const mockApplyRuntimeHints = vi.mocked(applyRuntimeHintsToApp);
export const mockClearRuntimeHints = vi.mocked(clearRuntimeHintsFromApp);
export const mockPrewarmIosRunnerSession = vi.mocked(prewarmIosRunnerSession);
export const mockPrewarmAppleRunnerCache = vi.mocked(prewarmAppleRunnerCache);
export const mockPrepareIosRunner = vi.mocked(prepareIosRunner);
export const mockStopIosRunner = vi.mocked(stopIosRunnerSession);
export const mockScheduleIosRunnerIdleStop = vi.mocked(scheduleIosRunnerIdleStop);
export const mockDismissMacOsAlert = vi.mocked(runMacOsAlertAction);
export const mockSettleSimulator = vi.mocked(settleIosSimulator);
export const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);
export const mockCleanupRetainedMaterializedPaths = vi.mocked(
  cleanupRetainedMaterializedPathsForSession,
);
export const mockRunCmd = vi.mocked(runCmd);
export const mockShutdownSimulator = vi.mocked(shutdownSimulator);
export const mockListAndroidDevices = vi.mocked(listAndroidDevices);
export const mockListAppleDevices = vi.mocked(listAppleDevices);
export const mockResolveIosApp = vi.mocked(resolveIosApp);
export const mockResolveIosSimulatorDeepLinkBundleId = vi.mocked(
  resolveIosSimulatorDeepLinkBundleId,
);
export const mockEnsureAndroidEmulatorBooted = vi.mocked(ensureAndroidEmulatorBooted);
export const mockStartAppLog = vi.mocked(startAppLog);
export const mockStopAppLog = vi.mocked(stopAppLog);
export const mockRunAppLogDoctor = vi.mocked(runAppLogDoctor);
export const mockDefaultInstallOpsIos = vi.mocked(defaultInstallOps.ios);
export const mockDefaultInstallOpsAndroid = vi.mocked(defaultInstallOps.android);
export const mockDefaultReinstallOpsIos = vi.mocked(defaultReinstallOps.ios);
export const mockDefaultReinstallOpsAndroid = vi.mocked(defaultReinstallOps.android);

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
  mockScheduleIosRunnerIdleStop.mockReset();
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
  mockRunAppLogDoctor.mockReset();
  mockRunAppLogDoctor.mockResolvedValue({ checks: {}, notes: [] });
  mockDefaultInstallOpsIos.mockReset();
  mockDefaultInstallOpsAndroid.mockReset();
  mockDefaultReinstallOpsIos.mockReset();
  mockDefaultReinstallOpsAndroid.mockReset();
});

export function makeSessionStore(): SessionStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-session-handler-'));
  return new SessionStore(path.join(root, 'sessions'));
}

export function makeSession(name: string, device: SessionState['device']): SessionState {
  return {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
  };
}

export const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({
  ok: true,
  data: {},
});

export function assertInvalidArgsMessage(response: DaemonResponse | null, message: string): void {
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe(message);
  }
}

export async function withMockedPlatform<T>(
  platform: NodeJS.Platform,
  fn: () => Promise<T>,
): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}
