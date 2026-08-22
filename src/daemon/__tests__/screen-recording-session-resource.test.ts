import { expect, test, vi } from 'vitest';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { ScreenRecordingLiveHandle } from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';
import {
  adoptStartedScreenRecording,
  finishLiveScreenRecording,
} from '../screen-recording-session-resource.ts';
import { screenRecordingResourceStore } from '../screen-recording-resource-store.ts';
import type { SessionState } from '../types.ts';

test('screen recording persists durable truth before adopting only handle and envelope', async () => {
  const sessionStore = makeSessionStore('screen-recording-session-resource-');
  const sessionName = 'recording';
  const session: SessionState = {
    name: sessionName,
    device: { platform: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    createdAt: 1,
    actions: [],
  };
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
    finishLiveScreenRecording({ session: active, sessionName, sessionStore }),
  ).resolves.toMatchObject({ backend: 'android', outPath: '/tmp/recording.mp4' });
  expect(finish).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)?.screenRecording).toBeUndefined();
});

function resourcePath(sessionStore: ReturnType<typeof makeSessionStore>, sessionName: string) {
  return screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName));
}
