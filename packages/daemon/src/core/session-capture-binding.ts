import { createDurableCaptureSessionBinding } from '@agent-device/capture-kit/durable-capture/session-binding';
import type {
  DurableCaptureSessionBinding,
  DurableCaptureSessionResource,
} from '@agent-device/capture-kit/durable-capture';
import { AppError } from '@agent-device/kernel/errors';
import type { SessionRef, SessionState } from './session-state.ts';
import type { SessionStore } from './session-store.ts';

export function bindSessionCapture<K extends string, H extends AsyncDisposable>(
  sessionStore: SessionStore,
  ref: SessionRef,
  slot: Readonly<{
    read(session: SessionState): DurableCaptureSessionResource<K, H> | undefined;
    write(resource: DurableCaptureSessionResource<K, H> | undefined): void;
  }>,
): DurableCaptureSessionBinding<K, H> {
  return createDurableCaptureSessionBinding({
    address: ref.address,
    sessionDir: sessionStore.resolveSessionDir(ref.address),
    initialSession: ref.session,
    resolveCurrent: () => sessionStore.resolveCurrent(ref),
    requireCurrent: () => sessionStore.requireCurrent(ref),
    assertAdmissionOpen: () => sessionStore.assertAdmissionOpen(ref.address),
    ...slot,
  });
}

export function bindSessionAudioProbe(sessionStore: SessionStore, ref: SessionRef) {
  return bindSessionCapture(sessionStore, ref, {
    read: (session) => session.audioProbe,
    write: (audioProbe) => {
      sessionStore.update(ref, { audioProbe });
    },
  });
}

export function bindSessionPerfCapture(sessionStore: SessionStore, ref: SessionRef) {
  return bindSessionCapture(sessionStore, ref, {
    read: (session) => session.perfCapture,
    write: (perfCapture) => {
      sessionStore.update(ref, { perfCapture });
    },
  });
}

export function bindSessionScreenRecording(sessionStore: SessionStore, ref: SessionRef) {
  return bindSessionCapture(sessionStore, ref, {
    read: (session) => session.screenRecording,
    write: (screenRecording) => {
      sessionStore.update(ref, { screenRecording });
    },
  });
}

export function bindRecordOnlyScreenRecording(
  sessionStore: SessionStore,
  address: string,
  draft: SessionRef['session'],
) {
  let published:
    | Readonly<{
        ref: SessionRef;
        binding: ReturnType<typeof bindSessionScreenRecording>;
      }>
    | undefined;
  const assertAdoptable = (): void => {
    if (published) {
      sessionStore.requireCurrent(published.ref);
      throw new AppError('COMMAND_FAILED', 'Recording draft has already been published', {
        reason: 'session_resource_changed',
        session: address,
      });
    }
    sessionStore.assertPublishable(address);
  };
  const binding: ReturnType<typeof bindSessionScreenRecording> = Object.freeze({
    address,
    sessionDir: sessionStore.resolveSessionDir(address),
    read: () => published?.binding.read(),
    assertAdoptable,
    canPersist: () => !published && sessionStore.lookup(address) === undefined,
    adopt: (screenRecording) => {
      assertAdoptable();
      if (draft.screenRecording) {
        throw new AppError('COMMAND_FAILED', 'Recording draft already owns a resource', {
          reason: 'session_resource_changed',
          session: address,
        });
      }
      const ref = sessionStore.publish(address, draft);
      const binding = bindSessionScreenRecording(sessionStore, ref);
      binding.adopt(screenRecording);
      published = Object.freeze({ ref, binding });
    },
    clear: (expected) => published?.binding.clear(expected) ?? 'retired',
  });
  return Object.freeze({
    binding,
    requireRef: (): SessionRef => {
      if (!published) throw new TypeError('Screen recording did not publish its session');
      return published.ref;
    },
  });
}
