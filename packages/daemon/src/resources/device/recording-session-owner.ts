import { AppError } from '@agent-device/kernel/errors';
import {
  beginRecordingClaimAppEvent,
  retainRecordingClaimForSession,
  settleRecordingClaimAppEvent,
} from '@agent-device/daemon-contracts/device-claims';
import type { AppEventDispatchOutcome } from '@agent-device/contracts/app-event-runtime';
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

/** Retain an unknown event until the platform and request binding both settle it. */
export async function beginSessionAppEvent(
  store: SessionStore,
  ref: SessionRef,
): Promise<((outcome: AppEventDispatchOutcome) => Promise<void>) | undefined> {
  const session = store.requireCurrent(ref);
  const ownership = session.deviceClaim;
  if (!ownership) return undefined;
  const result = await beginRecordingClaimAppEvent(ownership, store.host.env, session.appBundleId);
  if (result.status === 'ordinary') return undefined;
  if (result.status !== 'started')
    throw new AppError('DEVICE_IN_USE', 'The recording session owner is not settled', {
      reason: 'cleanup-unconfirmed',
      retriable: true,
    });
  return async (outcome) => {
    const settled = await settleRecordingClaimAppEvent(
      ownership,
      store.host.env,
      result.attempt,
      outcome,
    );
    if (settled === 'ownership-changed')
      throw new AppError('DEVICE_IN_USE', 'The recording device claim changed', {
        reason: 'DEVICE_CLAIM_OWNER_UNCERTAIN',
      });
  };
}
