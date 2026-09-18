import { expect, test, vi } from 'vitest';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { ScreenRecordingLiveHandle } from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope } from '../../durable-resource-envelope.ts';
import { createScreenRecordingLiveHandle } from '../../screen-recording-live-handle.ts';
import { stopAndExportScreenRecording } from '../../recording/stop-sequence.ts';
import { createScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';
import {
  adoptStartedScreenRecording,
  finishLiveScreenRecording,
} from '../screen-recording-session-resource.ts';
import { screenRecordingResourceStore } from '../screen-recording-resource-store.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DurableCaptureSessionState } from '../session-state-slice.ts';
import {
  makeCaptureAdmissionSessionStore,
  type CaptureAdmissionSessionStore,
} from './session-store.fixtures.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
};
/** The recording slot the family owns, plus the device this test reads back off the record. */
type TestRecordingSession = DurableCaptureSessionState &
  Readonly<{ name: string; device: DeviceInfo }>;

test('screen recording persists durable truth before adopting only handle and envelope', async () => {
  const sessionStore = makeCaptureAdmissionSessionStore<TestRecordingSession>(
    'screen-recording-session-resource-',
  );
  const sessionName = 'recording';
  const session: TestRecordingSession = { name: sessionName, device };
  sessionStore.set(sessionName, session);
  const owner = localRuntimeOwner('android');
  const fence = { token: 'recording-fence', generation: 1 } as const;
  const finish = vi.fn(async () => ({
    status: 'completed' as const,
    result: {
      backend: 'android',
      outPath: '/tmp/recording.mp4',
      startedAt: 1,
      completedAt: 2,
      scope: 'app' as const,
      showTouches: true,
      recordOnlySession: false,
    },
  }));
  const handle: ScreenRecordingLiveHandle = {
    inspect: () => ({
      backend: 'android',
      outPath: '/tmp/recording.mp4',
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
    finish,
    forceCleanup: async () => ({ status: 'cleaned' }),
    [Symbol.asyncDispose]: async () => {},
  };
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: sessionName,
    device: { id: session.device.id, family: 'android', kind: 'emulator' },
    owner,
    fence,
    lifecycle: 'open',
    descriptor: { version: 1, body: { recordingId: 'recording-id' } },
  });

  await adoptStartedScreenRecording({
    admissionLedger: createScreenRecordingAdmissionLedger(),
    session,
    sessionName,
    sessionStore,
    device: session.device,
    owner,
    fence,
    pendingHandle: new PendingTransferGuard(handle),
    envelope,
    throwIfCanceled: () => {},
  });

  expect(sessionStore.get(sessionName)?.screenRecording).toMatchObject({
    handle,
    envelope: { ...envelope, metadata: { phase: 'active' } },
  });
  expect(screenRecordingResourceStore.read(resourcePath(sessionStore, sessionName))).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'active' } },
  });

  const active = sessionStore.get(sessionName);
  if (!active) throw new Error('Expected screen-recording session');
  await expect(
    finishLiveScreenRecording({ intent: 'capture', session: active, sessionName, sessionStore }),
  ).resolves.toMatchObject({ backend: 'android', outPath: '/tmp/recording.mp4' });
  expect(finish).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)?.screenRecording).toBeUndefined();
});

test('a failed recording finish keeps the record open and never disposes the recording', async () => {
  const sessionStore = makeCaptureAdmissionSessionStore<TestRecordingSession>(
    'screen-recording-failed-finish-',
  );
  const sessionName = 'recording';
  const session: TestRecordingSession = { name: sessionName, device };
  sessionStore.set(sessionName, session);
  const owner = localRuntimeOwner('android');
  const fence = { token: 'recording-fence', generation: 1 } as const;
  const finishError = new Error('failed to retrieve playable Android recording');
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const handle: ScreenRecordingLiveHandle = {
    inspect: () => ({
      backend: 'android',
      outPath: '/tmp/recording.mp4',
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
    finish: async () => {
      throw finishError;
    },
    forceCleanup,
    [Symbol.asyncDispose]: async () => {},
  };
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: sessionName,
    device: { id: session.device.id, family: 'android', kind: 'emulator' },
    owner,
    fence,
    lifecycle: 'open',
    descriptor: { version: 1, body: { recordingId: 'recording-id' } },
  });
  await adoptStartedScreenRecording({
    admissionLedger: createScreenRecordingAdmissionLedger(),
    session,
    sessionName,
    sessionStore,
    device: session.device,
    owner,
    fence,
    pendingHandle: new PendingTransferGuard(handle),
    envelope,
    throwIfCanceled: () => {},
  });

  const active = sessionStore.get(sessionName);
  if (!active) throw new Error('Expected screen-recording session');
  await expect(
    finishLiveScreenRecording({ intent: 'capture', session: active, sessionName, sessionStore }),
  ).rejects.toBe(finishError);

  expect(forceCleanup).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)?.screenRecording?.handle).toBe(handle);
  expect(screenRecordingResourceStore.read(resourcePath(sessionStore, sessionName))).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'completing' } },
  });
});

test('a record stop that fails after collecting resumes through the fence without a second signal', async () => {
  const sessionStore = makeCaptureAdmissionSessionStore<TestRecordingSession>(
    'screen-recording-resumed-stop-',
  );
  const sessionName = 'recording';
  const session: TestRecordingSession = { name: sessionName, device };
  sessionStore.set(sessionName, session);
  const owner = localRuntimeOwner('android');
  const fence = { token: 'recording-fence', generation: 1 } as const;
  const signals = vi.fn(async () => ({ observation: { recorder: 'confirmed' as const } }));
  const copies = vi.fn(async (_collectedPath: string) => {});
  const exports = vi.fn(async () => {
    if (exports.mock.calls.length === 1) throw new Error('overlay export failed');
    return {
      telemetryPath: '/tmp/recording.telemetry.json',
      nativePathDisposition: 'retired' as const,
    };
  });
  const handle = createScreenRecordingLiveHandle(
    {
      backend: 'android',
      outPath: '/tmp/recording.mp4',
      startedAt: 1,
      scope: 'app',
      showTouches: false,
      recordOnlySession: false,
      gestureEvents: [],
    },
    {
      // The real sequence behind the real handle: only the device work is counted.
      finish: (snapshot, progress) =>
        stopAndExportScreenRecording({
          snapshot,
          progress,
          steps: { stop: signals, collect: copies, finalize: exports, discard: async () => {} },
        }),
      forceCleanup: async () => ({ status: 'cleaned' }),
    },
  );
  await adoptStartedScreenRecording({
    admissionLedger: createScreenRecordingAdmissionLedger(),
    session,
    sessionName,
    sessionStore,
    device: session.device,
    owner,
    fence,
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: sessionName,
      device: { id: session.device.id, family: 'android', kind: 'emulator' },
      owner,
      fence,
      lifecycle: 'open',
      descriptor: { version: 1, body: { recordingId: 'recording-id' } },
    }),
    throwIfCanceled: () => {},
  });
  const stop = () => {
    const active = sessionStore.get(sessionName);
    if (!active) throw new Error('Expected screen-recording session');
    return finishLiveScreenRecording({
      intent: 'capture',
      session: active,
      sessionName,
      sessionStore,
    });
  };

  await expect(stop()).rejects.toThrow('overlay export failed');
  expect(screenRecordingResourceStore.read(resourcePath(sessionStore, sessionName))).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'open',
      metadata: {
        stopObservation: { recorder: 'confirmed' },
        collectedPath: '/tmp/recording.collected.mp4',
      },
    },
  });

  await expect(stop()).resolves.toMatchObject({
    outPath: '/tmp/recording.mp4',
    telemetryPath: '/tmp/recording.telemetry.json',
    stopObservation: { recorder: 'confirmed' },
    nativePathDisposition: 'retired',
  });
  expect(signals).toHaveBeenCalledOnce();
  expect(copies).toHaveBeenCalledOnce();
  expect(exports).toHaveBeenCalledTimes(2);
  expect(sessionStore.get(sessionName)?.screenRecording).toBeUndefined();
});

function resourcePath(
  sessionStore: CaptureAdmissionSessionStore<TestRecordingSession>,
  sessionName: string,
) {
  return screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName));
}
