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
  let retained = slot.read(sessionStore.resolveCurrent(ref) ?? ref.session);
  const assertAdoptable = (): void => {
    sessionStore.assertAdmissionOpen(ref.address);
    if (slot.read(sessionStore.requireCurrent(ref))) {
      throw new AppError('COMMAND_FAILED', 'Session capture resource has changed', {
        reason: 'session_resource_changed',
        session: ref.address,
      });
    }
  };
  return Object.freeze({
    address: ref.address,
    sessionDir: sessionStore.resolveSessionDir(ref.address),
    read: () => {
      const current = sessionStore.resolveCurrent(ref);
      if (current) retained = slot.read(current);
      return retained;
    },
    assertAdoptable,
    canPersist: () => {
      const current = sessionStore.resolveCurrent(ref);
      return current !== undefined && slot.read(current) === undefined;
    },
    adopt: (resource) => {
      assertAdoptable();
      slot.write(resource);
      retained = resource;
    },
    clear: (expected) => {
      const current = sessionStore.resolveCurrent(ref);
      if (!current) return 'retired';
      const active = slot.read(current);
      if (
        active?.handle !== expected.handle ||
        active.envelope.fence.token !== expected.envelope.fence.token ||
        active.envelope.fence.generation !== expected.envelope.fence.generation
      )
        return 'resource-changed';
      slot.write(undefined);
      retained = undefined;
      return 'cleared';
    },
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
