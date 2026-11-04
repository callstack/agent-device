import { AppError } from '@agent-device/kernel/errors';
import { retainRecordingClaimForSession } from '@agent-device/daemon-contracts/device-claims';
import type { SessionStore } from '../../core/session-store.ts';
import type { SessionRef } from '../../core/session-state.ts';

/** Fence another session-owned effect before it can escape a recording-held claim. */
export async function retainSessionOwnerForRecording(
  store: SessionStore,
  ref: SessionRef,
): Promise<void> {
  const session = store.requireCurrent(ref);
  if (!session.deviceClaim) return;
  const result = await retainRecordingClaimForSession(session.deviceClaim, store.host.env);
  if (result === 'retained' || result === 'ordinary') return;
  throw new AppError('DEVICE_IN_USE', 'The recording session owner is not settled', {
    reason: 'cleanup-unconfirmed',
    retriable: true,
  });
}
