import { expect, vi } from 'vitest';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  PendingTransferGuard,
  type CleanupOutcome,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type RuntimeOperationUnavailability,
  type ScreenRecordingLiveHandle,
} from '@agent-device/contracts/platform';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { createScreenRecordingAdmissionLedger } from '../../screen-recording-admission-ledger.ts';
import { screenRecordingResourceStore } from '../../screen-recording-resource-store.ts';
import type { BindDeviceRuntime, BindExactDeviceRuntime } from '../../request-runtime-binding.ts';
import type { SessionState } from '../../types.ts';
import { handleRecordCommand } from '../record-runtime.ts';

type RuntimeOptions = {
  reattachActive?: boolean;
  reattachUnreattachable?: boolean;
  finishError?: Error;
  cleanup?: CleanupOutcome;
  screenRecordingStartFact?: RuntimeOperationUnavailability;
};

export function makeRecordRuntimeHarness(
  prefix: string,
  options: {
    sessionName?: string;
    appBundleId?: string;
    recordOnlySession?: boolean;
    platform?: 'android' | 'linux' | 'vega';
    runtime?: RuntimeOptions;
  } = {},
) {
  const sessionStore = makeSessionStore(prefix);
  const sessionName = options.sessionName ?? 'recording';
  const session: SessionState = {
    name: sessionName,
    device:
      options.platform === 'linux'
        ? { platform: 'linux', id: 'linux', name: 'Linux', kind: 'device', target: 'desktop' }
        : options.platform === 'vega'
          ? { platform: 'vega', id: 'vega', name: 'Vega', kind: 'device', target: 'tv' }
          : { platform: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    ...(options.appBundleId ? { appBundleId: options.appBundleId } : {}),
    ...(options.recordOnlySession ? { recordOnlySession: true } : {}),
    createdAt: 1,
    actions: [],
  };
  sessionStore.set(sessionName, session);
  const runtime = makeRuntime(session, options.runtime);
  const common = {
    sessionName,
    sessionStore,
    bindDevice: runtime.bindDevice,
    bindExactDevice: runtime.bindExactDevice,
    admissionLedger: createScreenRecordingAdmissionLedger(),
    requestScope: testRequestScope(),
    retainDeviceExecutionLock: async () => {},
    throwIfCanceled: () => {},
  };

  return {
    session,
    sessionName,
    sessionStore,
    runtime,
    run: (positionals: string[], meta?: { cwd: string }) =>
      handleRecordCommand({
        ...common,
        req: {
          token: 'token',
          session: sessionName,
          command: 'record',
          positionals,
          flags: {},
          ...(meta ? { meta } : {}),
        },
      }),
  };
}

export function expectDecodedCompletedRecording(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
): void {
  expect(
    screenRecordingResourceStore.read(recordingResourcePath(sessionStore, sessionName)),
  ).toMatchObject({ status: 'decoded', envelope: { lifecycle: 'completed' } });
}

export function recordingResourcePath(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
): string {
  return screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName));
}

function makeRuntime(session: SessionState, options: RuntimeOptions = {}) {
  const owner = localRuntimeOwner(session.device.platform);
  let currentOutPath = '';
  const handle: ScreenRecordingLiveHandle = {
    inspect: () => ({
      backend: 'adb screenrecord',
      outPath: currentOutPath,
      startedAt: 1,
      scope: 'app',
      showTouches: true,
      recordOnlySession: false,
      gestureEvents: [],
    }),
    appendGestureEvents: () => {},
    setTouchReferenceFrame: () => {},
    setRunnerSessionId: () => {},
    invalidate: () => {},
    finish: vi.fn(async () => {
      if (options.finishError) throw options.finishError;
      return {
        status: 'completed' as const,
        result: {
          backend: 'adb screenrecord',
          outPath: currentOutPath,
          startedAt: 1,
          completedAt: 2,
          scope: 'app' as const,
          showTouches: true,
          recordOnlySession: false,
        },
      };
    }),
    forceCleanup: vi.fn(async () => options.cleanup ?? { status: 'cleaned' as const }),
    [Symbol.asyncDispose]: async () => {},
  };
  const start = vi.fn(
    async (input: Parameters<PlatformRuntimeOperations['screenRecordingStart']>[0]) => {
      currentOutPath = input.outputPath;
      return {
        pendingHandle: new PendingTransferGuard(handle),
        envelope: createDurableResourceEnvelope({
          resourceKind: 'screen-recording',
          sessionId: input.sessionId,
          device: {
            id: session.device.id,
            family: session.device.platform,
            kind: session.device.kind,
            ...(session.device.target === undefined ? {} : { target: session.device.target }),
          },
          owner,
          fence: input.fence,
          lifecycle: 'open',
          descriptor: { version: 1, body: { recordingId: 'id' } },
        }),
      };
    },
  );
  const reattach = vi.fn(async () => {
    if (options.reattachActive) return { status: 'active', handle } as const;
    if (options.reattachUnreattachable) {
      return {
        status: 'unreattachable',
        reason: 'transport-not-reattachable',
        message: 'Live recording control cannot be reconstructed',
      } as const;
    }
    return { status: 'missing' } as const;
  });
  const cleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const operations = {
    screenRecordingStart: start,
    screenRecordingReattach: reattach,
    screenRecordingCleanup: cleanup,
  };
  const binding: DeviceBinding<PlatformRuntimeOperations> = {
    device: session.device,
    owner,
    facts: {
      device: {
        family: session.device.platform,
        kind: session.device.kind,
        ...(session.device.target === undefined ? {} : { target: session.device.target }),
        providerMode: 'local',
      },
      operations: {
        appLogInspect: unavailable,
        appLogDoctor: unavailable,
        appLogStart: unavailable,
        appLogReattach: unavailable,
        appLogCleanup: unavailable,
        appState: unavailable,
        networkDump: unavailable,
        screenRecordingStart: options.screenRecordingStartFact ?? { available: true },
        screenRecordingReattach: { available: true },
        screenRecordingCleanup: { available: true },
        ensureReady: unavailable,
        bootTarget: unavailable,
        bootTargetHeadless: unavailable,
        listApps: unavailable,
      },
    },
    operations,
    [Symbol.asyncDispose]: async () => {},
  };
  const bindDevice: BindDeviceRuntime = async (_device, use) => narrowDeviceBinding(binding, use);
  const bindExactDeviceCalls = vi.fn();
  const bindExactDevice: BindExactDeviceRuntime = async (device, ownerRef, fence, use, scope) => {
    bindExactDeviceCalls(device, ownerRef, fence, use, scope);
    return narrowDeviceBinding(binding, use);
  };
  return {
    bindDevice,
    bindExactDevice,
    bindExactDeviceCalls,
    handle,
    start,
    reattach,
    cleanup,
    finish: handle.finish,
    forceCleanup: handle.forceCleanup,
  };
}

const unavailable = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});

function testRequestScope() {
  return {
    signal: new AbortController().signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
}
