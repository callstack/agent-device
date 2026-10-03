import { bindSessionScreenRecording } from './session-capture-binding.ts';
import type { SessionRef } from './session-state.ts';
import type { SessionStore } from './session-store.ts';

export function bindRecordOnlyScreenRecording(
  sessionStore: SessionStore,
  address: string,
  draft: SessionRef['session'],
) {
  let published: SessionRef | undefined;
  const binding: ReturnType<typeof bindSessionScreenRecording> = Object.freeze({
    address,
    sessionDir: sessionStore.resolveSessionDir(address),
    read: () =>
      published ? bindSessionScreenRecording(sessionStore, published).read() : undefined,
    assertAdoptable: () => sessionStore.assertPublishable(address),
    canPersist: () => !published && sessionStore.lookup(address) === undefined,
    adopt: (screenRecording) => {
      sessionStore.assertPublishable(address);
      draft.screenRecording = screenRecording;
      published = sessionStore.publish(address, draft);
    },
    clear: (expected) =>
      published ? bindSessionScreenRecording(sessionStore, published).clear(expected) : 'retired',
  });
  return Object.freeze({
    binding,
    requireRef: (): SessionRef => {
      if (!published) throw new TypeError('Screen recording did not publish its session');
      return published;
    },
  });
}
