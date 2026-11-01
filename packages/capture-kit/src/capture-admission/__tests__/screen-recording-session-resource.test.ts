import { makeCaptureSessionBinding } from '../../durable-capture/session-binding.fixtures.ts';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { ScreenRecordingLiveHandle } from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope } from '../../durable-resource-envelope.ts';
import { createScreenRecordingLiveHandle } from '../../screen-recording-live-handle.ts';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';
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
  const binding = makeCaptureSessionBinding(sessionStore, sessionName, {
    read: (session) => session.screenRecording,
    replace: (session, screenRecording) => ({ ...session, screenRecording }),
  });
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
    binding,
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
  await expect(finishLiveScreenRecording({ intent: 'capture', binding })).resolves.toMatchObject({
    backend: 'android',
    outPath: '/tmp/recording.mp4',
  });
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
  const binding = makeCaptureSessionBinding(sessionStore, sessionName, {
    read: (session) => session.screenRecording,
    replace: (session, screenRecording) => ({ ...session, screenRecording }),
  });
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
    binding,
    device: session.device,
    owner,
    fence,
    pendingHandle: new PendingTransferGuard(handle),
    envelope,
    throwIfCanceled: () => {},
  });

  const active = sessionStore.get(sessionName);
  if (!active) throw new Error('Expected screen-recording session');
  await expect(finishLiveScreenRecording({ intent: 'capture', binding })).rejects.toBe(finishError);

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
  const binding = makeCaptureSessionBinding(sessionStore, sessionName, {
    read: (session) => session.screenRecording,
    replace: (session, screenRecording) => ({ ...session, screenRecording }),
  });
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
    binding,
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
      binding,
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

/**
 * What session teardown does with a recording `record stop` already committed: the queued disposal had
 * read the session's recording before that stop, so it still holds the handle and the fence the record
 * names. It is answered with the export the stop produced and signals the recorder no second time.
 * Before the record could answer for its own export, this refusal surfaced as an unreleased resource on
 * session cleanup, and a second `record stop` looked like a failure to callers.
 */
test('a disposal queued behind a committed recording stop replays that export', async () => {
  const recording = await adoptCommittedRecording('screen-recording-replayed-stop-');
  const stopped = await finishLiveScreenRecording({
    intent: 'capture',
    binding: recording.binding,
  });
  recording.requeue();

  await expect(
    finishLiveScreenRecording({ intent: 'disposal', binding: recording.binding }),
  ).resolves.toEqual(stopped);
  expect(recording.signals).toHaveBeenCalledOnce();
  expect(recording.binding.read()).toBeUndefined();
});

/**
 * A committed record whose export file no longer exists has nothing serveable, and this kind never
 * hands a caller a path it cannot download. The surviving-file check belongs to the reader both
 * consumers share, so a disposal queued behind a stop whose clip was removed keeps the typed
 * refusal teardown settles, rather than reporting a successful stop for a deleted file.
 */
test('a disposal queued behind a deleted export refuses instead of serving the missing path', async () => {
  const recording = await adoptCommittedRecording('screen-recording-deleted-stop-');
  await finishLiveScreenRecording({ intent: 'capture', binding: recording.binding });
  fs.rmSync(recording.outPath);
  recording.requeue();

  await expect(
    finishLiveScreenRecording({ intent: 'disposal', binding: recording.binding }),
  ).rejects.toMatchObject({ details: { reason: 'resource-already-completed' } });
  expect(recording.signals).toHaveBeenCalledOnce();
});

/**
 * A recording adopted into a session, with the recorder's stop driven through the real export
 * sequence, so the committed record holds the stop response the kind journals on commit.
 */
async function adoptCommittedRecording(prefix: string) {
  const sessionStore = makeCaptureAdmissionSessionStore<TestRecordingSession>(prefix);
  const sessionName = 'recording';
  const session: TestRecordingSession = { name: sessionName, device };
  sessionStore.set(sessionName, session);
  const binding = makeCaptureSessionBinding(sessionStore, sessionName, {
    read: (session) => session.screenRecording,
    replace: (session, screenRecording) => ({ ...session, screenRecording }),
  });
  const owner = localRuntimeOwner('android');
  const fence = { token: 'recording-fence', generation: 1 } as const;
  const outPath = path.join(mkdtempForTestSync(`${prefix}export-`), 'recording.mp4');
  fs.writeFileSync(outPath, 'mp4');
  const signals = vi.fn(async () => ({ observation: { recorder: 'confirmed' as const } }));
  const handle = createScreenRecordingLiveHandle(
    {
      backend: 'android',
      outPath,
      startedAt: 1,
      scope: 'app',
      showTouches: false,
      recordOnlySession: false,
      gestureEvents: [],
    },
    {
      finish: (snapshot, progress) =>
        stopAndExportScreenRecording({
          snapshot,
          progress,
          steps: {
            stop: signals,
            collect: async () => {},
            finalize: async () => ({ nativePathDisposition: 'retired' as const }),
            discard: async () => {},
          },
        }),
      forceCleanup: async () => ({ status: 'cleaned' }),
    },
  );
  await adoptStartedScreenRecording({
    admissionLedger: createScreenRecordingAdmissionLedger(),
    binding,
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
  // The queued teardown's own view of the slot, captured while the record was still open.
  const queued = binding.read();
  if (!queued) throw new Error('Expected adopted screen recording');
  return {
    binding,
    signals,
    outPath,
    /** Puts the slot back the way the queued teardown left it holding it. */
    requeue: () => {
      binding.adopt(queued);
    },
  };
}

function resourcePath(
  sessionStore: CaptureAdmissionSessionStore<TestRecordingSession>,
  sessionName: string,
) {
  return screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName));
}
