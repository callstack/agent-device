import { AppError } from '@agent-device/kernel/errors';
import {
  bindSessionScreenRecording,
  publishRecordOnlyScreenRecording,
} from './session-capture-binding.ts';
import type { SessionRef } from './session-state.ts';
import type { SessionStore } from './session-store.ts';

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
      const ref = publishRecordOnlyScreenRecording(sessionStore, address, draft, screenRecording);
      published = Object.freeze({ ref, binding: bindSessionScreenRecording(sessionStore, ref) });
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
