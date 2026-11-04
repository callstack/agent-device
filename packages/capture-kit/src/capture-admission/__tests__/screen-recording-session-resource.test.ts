import { makeCaptureSessionBinding } from '../../durable-capture/session-binding.fixtures.ts';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { ScreenRecordingLiveHandle } from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope } from '../../durable-resource-envelope.ts';
import { withDurableCaptureResourceFence } from '../../durable-capture/fence.ts';
import { markCompletingDurableCapture } from '../../durable-capture/transitions.ts';
import { createScreenRecordingLiveHandle } from '../../screen-recording-live-handle.ts';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';
import { stopAndExportScreenRecording } from '../../recording/stop-sequence.ts';
import { createScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';
import {
  adoptStartedScreenRecording,
  finishLiveScreenRecording,
  finishRecoveredScreenRecording,
} from '../screen-recording-session-resource.ts';
import { screenRecordingResourceStore } from '../screen-recording-resource-store.ts';
import { resolveScreenRecordingStopRecovery } from '../screen-recording-stop-recovery.ts';
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

test('an interrupted retry replays its bound export while the exact cleanup remains pending', async () => {
  const sessionStore = makeCaptureAdmissionSessionStore<TestRecordingSession>('pending-retry-');
  const sessionName = 'recording';
  sessionStore.set(sessionName, { name: sessionName, device });
  const binding = makeCaptureSessionBinding(sessionStore, sessionName, {
    read: (session) => session.screenRecording,
    replace: (session, screenRecording) => ({ ...session, screenRecording }),
  });
  const outPath = path.join(mkdtempForTestSync('pending-retry-output-'), 'recording.mp4');
  fs.writeFileSync(outPath, 'export bytes');
  const owner = localRuntimeOwner('android');
  const fence = { token: 'fence', generation: 7 } as const;
  const completion = {
    backend: 'adb screenrecord',
    outPath,
    startedAt: 1,
    completedAt: 2,
    scope: 'device' as const,
    showTouches: false,
    recordOnlySession: false,
    nativePathDisposition: 'pending' as const,
  };
  const handle = createScreenRecordingLiveHandle(
    { ...completion, gestureEvents: [] },
    {
      finish: async () => ({
        status: 'completed',
        result: completion,
        cleanupPending: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' },
      }),
      forceCleanup: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
    },
  );
  await adoptStartedScreenRecording({
    admissionLedger: createScreenRecordingAdmissionLedger(),
    binding,
    device,
    owner,
    fence,
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: sessionName,
      device: { id: device.id, family: 'android', kind: 'emulator' },
      owner,
      fence,
      lifecycle: 'open',
      descriptor: { version: 3, body: { outputPath: outPath, marker: 'exact-generation' } },
      metadata: { deviceClaimToken: 'claim-token' },
    }),
    throwIfCanceled: () => {},
  });
  await expect(finishLiveScreenRecording({ intent: 'capture', binding })).resolves.toEqual(
    completion,
  );
  const recordPath = resourcePath(sessionStore, sessionName);
  await expect(
    withDurableCaptureResourceFence({
      store: screenRecordingResourceStore,
      resourcePath: recordPath,
      expected: fence,
      onCompleted: () => undefined,
      run: async (lease) => {
        markCompletingDurableCapture(lease);
        throw new Error('interrupted immediately after completing checkpoint');
      },
    }),
  ).rejects.toThrow('interrupted immediately after completing checkpoint');
  const interrupted = screenRecordingResourceStore.read(recordPath);
  expect(interrupted).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'open',
      fence,
      metadata: {
        phase: 'completing',
        cleanupStatus: 'cleanup-pending',
        deviceClaimToken: 'claim-token',
      },
    },
  });
  if (interrupted.status !== 'decoded') throw new Error('Expected interrupted record');
  const expectedRecovery = {
    kind: 'open',
    resourcePath: recordPath,
    pendingCompletion: completion,
  };
  expect(resolveScreenRecordingStopRecovery({ sessionName, sessionStore, device })).toEqual(
    expectedRecovery,
  );
  const scope = {
    signal: new AbortController().signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
  const unavailable = async () => {
    throw new Error('owner unavailable');
  };
  await expect(
    finishRecoveredScreenRecording({
      resourcePath: recordPath,
      scope,
      acquireControl: unavailable,
    }),
  ).resolves.toEqual(completion);
  expect(screenRecordingResourceStore.read(recordPath)).toEqual(interrupted);
  for (const changed of [
    { ...interrupted.envelope, fence: { token: 'other-fence', generation: 7 } },
    {
      ...interrupted.envelope,
      descriptor: { version: 3, body: { outputPath: outPath, marker: 'other' } },
    },
    {
      ...interrupted.envelope,
      metadata: { ...interrupted.envelope.metadata, deviceClaimToken: 'other-claim' },
    },
  ]) {
    screenRecordingResourceStore.write(recordPath, changed);
    expect(resolveScreenRecordingStopRecovery({ sessionName, sessionStore, device })).toEqual({
      kind: 'open',
      resourcePath: recordPath,
    });
    await expect(
      finishRecoveredScreenRecording({
        resourcePath: recordPath,
        scope,
        acquireControl: unavailable,
      }),
    ).rejects.toThrow('owner unavailable');
    screenRecordingResourceStore.write(recordPath, interrupted.envelope);
    await expect(
      finishRecoveredScreenRecording({
        resourcePath: recordPath,
        scope,
        acquireControl: async () => {
          screenRecordingResourceStore.write(recordPath, changed);
          throw new Error('owner unavailable');
        },
      }),
    ).rejects.toMatchObject({ details: { reason: 'ownership-fence-lost' } });
  }
  screenRecordingResourceStore.write(recordPath, interrupted.envelope);
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
  expect(recording.finish).toHaveBeenCalledOnce();
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
  const finish = vi.fn(handle.finish);
  await adoptStartedScreenRecording({
    admissionLedger: createScreenRecordingAdmissionLedger(),
    binding,
    device: session.device,
    owner,
    fence,
    pendingHandle: new PendingTransferGuard({ ...handle, finish }),
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
    finish,
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

test('recovered stop waits for a cancelled reattach and preserves the native evidence', async () => {
  const dir = mkdtempForTestSync('recording-stop-late-');
  const resourcePath = screenRecordingResourceStore.resolvePath(dir);
  const nativePath = path.join(dir, 'native.mp4');
  fs.writeFileSync(nativePath, 'native bytes');
  screenRecordingResourceStore.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: 'session',
      device: { family: 'android', id: device.id, kind: device.kind },
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: {} },
    }),
  );
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const disposeControl = vi.fn(async () => {});
  const handle = createScreenRecordingLiveHandle(
    {
      backend: 'android',
      outPath: '/tmp/out',
      startedAt: 1,
      scope: 'device',
      showTouches: false,
      recordOnlySession: true,
      gestureEvents: [],
    },
    {
      finish: async () => {
        throw new Error('unexpected finish');
      },
      forceCleanup,
    },
  );
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const abort = new AbortController();
  const task = finishRecoveredScreenRecording({
    resourcePath,
    scope: {
      signal: abort.signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    acquireControl: async () => ({
      reattach: async () => {
        entered();
        await pending;
        return { status: 'active' as const, handle };
      },
      cleanup: forceCleanup,
      [Symbol.asyncDispose]: disposeControl,
    }),
  });
  const result = task.catch((error: unknown) => error);
  await started;
  abort.abort();
  await Promise.resolve();
  expect(disposeControl).not.toHaveBeenCalled();
  expect(forceCleanup).not.toHaveBeenCalled();
  release();
  await expect(result).resolves.toBeInstanceOf(Error);
  expect(forceCleanup).not.toHaveBeenCalled();
  expect(disposeControl).toHaveBeenCalledOnce();
  expect(fs.readFileSync(nativePath, 'utf8')).toBe('native bytes');
  expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });
});
