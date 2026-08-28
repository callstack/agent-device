import { vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../../platforms/apple/core/simulator.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/simulator.ts')>();
  return { ...actual, shutdownSimulator: vi.fn() };
});
vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});
vi.mock('../../../platforms/apple/core/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner-client.ts')>();
  return { ...actual, stopIosRunnerSession: vi.fn(async () => {}) };
});
vi.mock('../../../platforms/apple/core/perf-xctrace.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/perf-xctrace.ts')>();
  return { ...actual, cleanupAppleXctracePerfCapture: vi.fn(async () => ({})) };
});
vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    cleanupAndroidNativePerfSession: vi.fn(async () => {}),
    stopAndroidSnapshotHelperSessionForDevice: vi.fn(async () => {}),
  };
});
vi.mock('../../../platforms/apple/os/macos/helper.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/os/macos/helper.ts')>();
  return { ...actual, runMacOsAlertAction: vi.fn(async () => {}) };
});
vi.mock('../../../utils/video.ts', () => ({
  waitForStableFile: vi.fn(async () => {}),
  isPlayableVideo: vi.fn(async () => true),
}));
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
  mockShutdownTargetRuntime,
} from './session-command-harness.ts';
import { teardownSessionResources as teardownProductionSessionResources } from '../../session-teardown.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { shutdownSimulator } from '../../../platforms/apple/core/simulator.ts';
import { runCmd } from '@agent-device/host-kit/command';
import {
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { cleanupAppleXctracePerfCapture } from '../../../platforms/apple/core/perf-xctrace.ts';
import {
  cleanupAndroidNativePerfSession,
  stopAndroidSnapshotHelperSessionForDevice,
} from '@agent-device/platform-android/mechanics';
import { stopIosRunnerSession } from '../../../platforms/apple/core/runner-client.ts';
import { WEB_DESKTOP_DEVICE } from '../../../__tests__/test-utils/device-fixtures.ts';
import { acquireDeviceClaim } from '../../device-claims.ts';
import { inspectDeviceClaims } from '../../device-claim-inspection.ts';

import {
  type DeviceBinding,
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { ScreenRecordingLiveHandle } from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { screenRecordingResourceStore } from '../../screen-recording-resource-store.ts';
import { lifecycleRuntimeFacts } from './application-lifecycle-runtime-harness.ts';
import { dispatchApplicationLifecycleEffect } from '../../__tests__/application-lifecycle-runtime-fixture.ts';

export type { DeviceBinding, PlatformRuntimeOperations, SessionState };

const mockShutdownSimulator = vi.mocked(shutdownSimulator);
const mockRunCmd = vi.mocked(runCmd);
const mockDispatchCommand = vi.mocked(dispatchApplicationLifecycleEffect);
const mockCleanupAppleXctracePerfCapture = vi.mocked(cleanupAppleXctracePerfCapture);
const mockCleanupAndroidNativePerfSession = vi.mocked(cleanupAndroidNativePerfSession);
const mockStopAndroidSnapshotHelperSessionForDevice = vi.mocked(
  stopAndroidSnapshotHelperSessionForDevice,
);
const mockStopIosRunnerSession = vi.mocked(stopIosRunnerSession);

const teardownSessionResources = (
  request: Parameters<typeof teardownProductionSessionResources>[0],
) =>
  teardownProductionSessionResources({
    ...request,
    platformCleanup: request.platformCleanup ?? platformResourceCleanup,
  });

const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({
  ok: true,
  data: {},
});

function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-session-close-shutdown-');
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

function makeIosSimulatorRecordingSession(
  sessionStore: SessionStore,
  name: string,
  options: {
    recorderExitCode?: number;
    cleanupConfirmed?: boolean;
    device?: SessionState['device'];
  } = {},
): SessionState {
  const session = makeSession(
    name,
    options.device ?? {
      platform: 'apple',
      id: 'sim-udid-recording',
      name: 'iPhone 15',
      kind: 'simulator',
      booted: true,
    },
  );
  session.appBundleId = 'com.example.app';
  const outPath = path.join(os.tmpdir(), name + '.mp4');
  const finish = vi.fn(async () =>
    options.recorderExitCode
      ? ({
          status: 'cleanup-pending',
          reason: 'transport-failed',
          message: 'failed to stop recording',
        } as const)
      : ({
          status: 'completed',
          result: {
            backend: 'simctl recordVideo',
            outPath,
            startedAt: Date.now() - 5_000,
            completedAt: Date.now(),
            scope: 'app',
            showTouches: false,
            recordOnlySession: false,
          },
        } as const),
  );
  const forceCleanup = vi.fn(async () =>
    options.cleanupConfirmed === false
      ? ({
          status: 'cleanup-pending',
          reason: 'transport-failed',
          message: 'failed to force cleanup recording',
        } as const)
      : ({ status: 'cleaned' } as const),
  );
  const handle: ScreenRecordingLiveHandle = {
    inspect: () => ({
      backend: 'simctl recordVideo',
      outPath,
      startedAt: Date.now() - 5_000,
      scope: 'app',
      showTouches: false,
      recordOnlySession: false,
      gestureEvents: [],
    }),
    appendGestureEvents: () => {},
    setTouchReferenceFrame: () => {},
    setRunnerSessionId: () => {},
    invalidate: () => {},
    finish,
    forceCleanup,
    [Symbol.asyncDispose]: async () => {},
  };
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: name,
    device: { id: session.device.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
    owner: localRuntimeOwner('apple'),
    fence: { token: name + '-fence', generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: { recordingId: name } },
    metadata: { phase: 'active' },
  });
  session.screenRecording = {
    handle,
    envelope,
  };
  screenRecordingResourceStore.write(
    screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(name)),
    envelope,
  );
  return session;
}

function recordingFinishMock(session: SessionState): ReturnType<typeof vi.fn> {
  const recording = session.screenRecording;
  if (!recording) throw new Error('expected an active screen recording');
  return recording.handle.finish as ReturnType<typeof vi.fn>;
}

function recordingCleanupMock(session: SessionState): ReturnType<typeof vi.fn> {
  const recording = session.screenRecording;
  if (!recording) throw new Error('expected an active screen recording');
  return recording.handle.forceCleanup as ReturnType<typeof vi.fn>;
}

function resetSessionCloseShutdownMocks(): void {
  vi.clearAllMocks();
}

/**
 * Vitest hoists mocks in each importing test module. Keep the common runtime values behind one
 * explicit object export so split suites share the same mock instances without relying on a
 * re-export list through the hoisted transform.
 */
export const sessionCloseShutdownFixture = Object.freeze({
  acquireDeviceClaim,
  AppError,
  flushDiagnosticsToSessionFile,
  fs,
  handleSessionCommands,
  inspectDeviceClaims,
  LeaseRegistry,
  lifecycleRuntimeFacts,
  localRuntimeOwner,
  makeIosSimulatorRecordingSession,
  makeSession,
  makeSessionStore,
  mkdtempForTestSync,
  mockBindDeviceRuntime,
  mockCleanupAndroidNativePerfSession,
  mockCleanupAppleXctracePerfCapture,
  mockDispatchCommand,
  mockInspectDeviceRuntimeFacts,
  mockShutdownTargetRuntime,
  mockRunCmd,
  mockShutdownSimulator,
  mockStopAndroidSnapshotHelperSessionForDevice,
  mockStopIosRunnerSession,
  narrowDeviceBinding,
  noopInvoke,
  os,
  path,
  providerRuntimeOwner,
  recordingCleanupMock,
  recordingFinishMock,
  resetSessionCloseShutdownMocks,
  screenRecordingResourceStore,
  teardownSessionResources,
  WEB_DESKTOP_DEVICE,
  withDiagnosticsScope,
});
