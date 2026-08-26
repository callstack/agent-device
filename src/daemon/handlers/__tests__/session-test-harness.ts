import { isMacOs } from '@agent-device/kernel/device';
import { legacyDispatchCapture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { expect, vi, beforeEach } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import type { AppLogLiveState } from '@agent-device/contracts/app-log-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { createTestAppLogLiveHandle } from '../../../__tests__/test-utils/app-log-live-handle.ts';
import type { LogBackend } from '@agent-device/contracts/observability';

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: vi.fn(async () => undefined) };
});

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../__tests__/device-selection-stub.ts');
  const resolveTargetDevice = vi.fn();
  return {
    ...actual,
    resolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(resolveTargetDevice)),
  };
});
vi.mock('../../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('../../../platform-runtime-runtime-hints.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platform-runtime-runtime-hints.ts')>();
  return {
    ...actual,
    applyRuntimeHintValues: vi.fn(async () => {}),
    clearRuntimeHintValues: vi.fn(async () => {}),
  };
});
vi.mock('../../../platforms/apple/core/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner-client.ts')>();
  return {
    ...actual,
    prepareIosRunner: vi.fn(async () => ({
      runner: { currentUptimeMs: 42 },
      connectMs: 3,
      healthCheckMs: 3,
    })),
    prewarmAppleRunnerCache: vi.fn(),
    prewarmIosRunnerSession: vi.fn(),
    notifyIosRunnerAppRelaunched: vi.fn(async () => {}),
    scheduleIosRunnerIdleStop: vi.fn(),
    stopIosRunnerSession: vi.fn(async () => {}),
  };
});
vi.mock('../../../platforms/apple/os/macos/helper.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/os/macos/helper.ts')>();
  return { ...actual, runMacOsAlertAction: vi.fn(async () => {}) };
});
vi.mock('../../../platform-runtime-open-target.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform-runtime-open-target.ts')>();
  return { ...actual, resolveAndroidPackageForOpen: vi.fn(async () => undefined) };
});
vi.mock('../../../platforms/android/ime-lifecycle.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/ime-lifecycle.ts')>();
  return {
    ...actual,
    activateAndroidTestIme: vi.fn(async () => ({ activated: false })),
    restoreAndroidTestIme: vi.fn(async () => ({ restored: false, reason: 'no-record' })),
  };
});
vi.mock('../../../platforms/apple/core/simulator.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/simulator.ts')>();
  return { ...actual, getSimulatorState: vi.fn(async () => null) };
});
vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) };
});
vi.mock('../../materialized-path-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../materialized-path-registry.ts')>();
  return { ...actual, cleanupRetainedMaterializedPathsForSession: vi.fn(async () => {}) };
});
vi.mock('../../../platforms/apple/core/apps.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platforms/apple/core/apps.ts')>();
  return {
    ...actual,
    resolveIosApp: vi.fn(async () => undefined),
    resolveIosSimulatorDeepLinkBundleId: vi.fn(async () => undefined),
  };
});

import * as path from 'node:path';
import { cleanupRetainedMaterializedPathsForSession } from '../../materialized-path-registry.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import { resolveTargetDevice } from '../../../core/dispatch.ts';
import { ensureDeviceReady } from '../../device-ready.ts';
import {
  applyRuntimeHintValues,
  clearRuntimeHintValues,
} from '../../../platform-runtime-runtime-hints.ts';
import {
  prepareIosRunner,
  prewarmAppleRunnerCache,
  prewarmIosRunnerSession,
  notifyIosRunnerAppRelaunched,
  scheduleIosRunnerIdleStop,
  stopIosRunnerSession,
} from '../../../platforms/apple/core/runner-client.ts';
import { runMacOsAlertAction } from '../../../platforms/apple/os/macos/helper.ts';
import { resolveAndroidPackageForOpen } from '../../../platform-runtime-open-target.ts';
import { runCmd } from '../../../utils/exec.ts';
import {
  resolveIosApp,
  resolveIosSimulatorDeepLinkBundleId,
} from '../../../platforms/apple/core/apps.ts';
import { dispatchApplicationLifecycleEffect } from '../../__tests__/application-lifecycle-runtime-fixture.ts';

export const mockLifecycleDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
export const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
export const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);
const mockApplyRuntimeHints = vi.mocked(applyRuntimeHintValues);
export const mockClearRuntimeHints = vi.mocked(clearRuntimeHintValues);
export const mockPrewarmIosRunnerSession = vi.mocked(prewarmIosRunnerSession);
export const mockNotifyIosRunnerAppRelaunched = vi.mocked(notifyIosRunnerAppRelaunched);
export const mockPrewarmAppleRunnerCache = vi.mocked(prewarmAppleRunnerCache);
export const mockPrepareIosRunner = vi.mocked(prepareIosRunner);
export const mockStopIosRunner = vi.mocked(stopIosRunnerSession);
export const mockScheduleIosRunnerIdleStop = vi.mocked(scheduleIosRunnerIdleStop);
export const mockDismissMacOsAlert = vi.mocked(runMacOsAlertAction);
export const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);
export const mockCleanupRetainedMaterializedPaths = vi.mocked(
  cleanupRetainedMaterializedPathsForSession,
);
export const mockRunCmd = vi.mocked(runCmd);
/** The retired dispatcher's snapshot leg, now an owned test double (R58). */
export const mockDispatch = legacyDispatchCapture;
export const mockResolveIosApp = vi.mocked(resolveIosApp);
export const mockResolveIosSimulatorDeepLinkBundleId = vi.mocked(
  resolveIosSimulatorDeepLinkBundleId,
);

beforeEach(() => {
  vi.useRealTimers();
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockLifecycleDispatch.mockReset();
  mockLifecycleDispatch.mockResolvedValue(undefined);
  mockResolveTargetDevice.mockReset();
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
  mockApplyRuntimeHints.mockReset();
  mockApplyRuntimeHints.mockResolvedValue(undefined);
  mockClearRuntimeHints.mockReset();
  mockClearRuntimeHints.mockResolvedValue(undefined);
  mockPrewarmIosRunnerSession.mockReset();
  mockNotifyIosRunnerAppRelaunched.mockReset();
  mockNotifyIosRunnerAppRelaunched.mockResolvedValue(undefined);
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
  mockResolveAndroidPackage.mockReset();
  mockResolveAndroidPackage.mockResolvedValue(undefined);
  mockCleanupRetainedMaterializedPaths.mockReset();
  mockCleanupRetainedMaterializedPaths.mockResolvedValue(undefined);
  mockRunCmd.mockReset();
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
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
});

export function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-session-handler-');
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

export function makeTestAppLogResource(
  session: Pick<SessionState, 'name' | 'device'>,
  options: {
    backend: LogBackend;
    state?: AppLogLiveState;
    startedAt?: number;
    outputPath?: string;
  },
): NonNullable<SessionState['appLog']> {
  const outputPath = options.outputPath ?? '/tmp/app.log';
  const handle = createTestAppLogLiveHandle({
    inspect: () => ({
      backend: options.backend,
      state: options.state ?? 'active',
      startedAt: options.startedAt ?? Date.now(),
    }),
    finish: async () => ({
      status: 'completed',
      result: { backend: options.backend, outputPath, completedAt: Date.now() },
    }),
    forceCleanup: async () => ({ status: 'cleaned' }),
  });
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'app-log',
    sessionId: session.name,
    device: {
      id: session.device.id,
      family: session.device.platform,
      kind: session.device.kind,
      ...(session.device.appleOs === undefined ? {} : { appleOs: session.device.appleOs }),
      ...(session.device.target === undefined ? {} : { target: session.device.target }),
      ...(session.device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: session.device.iosPhysicalDeviceBackend }),
    },
    owner: localRuntimeOwner(session.device.platform),
    fence: { token: 'test-fence', generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: {} },
  });
  return { handle, envelope };
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
