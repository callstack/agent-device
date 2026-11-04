import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { sameDeviceIdentity } from '@agent-device/kernel/device';
import type { AppEventDispatchOutcome } from '@agent-device/contracts/app-event-runtime';
import {
  sameRuntimeOwner,
  type ResourceOwnershipFence,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import { ownerIdentityMatches } from '@agent-device/host-kit/process';
import {
  sameRecordingCloseIntent,
  sameRecordingAppEventOwner,
  type DeviceClaim,
  type DeviceClaimSessionOwnership,
  type RecordingCloseIntent,
} from './device-claim-record.ts';
import { writeDeviceClaim } from './device-claim-store.ts';
import { writeOwnedDeviceClaim } from './device-claim-owned.ts';

/** Retain a recording claim before its session dispatches another owner effect. */
export async function retainRecordingClaimForSession(
  ownership: DeviceClaimSessionOwnership,
  env: EnvMap,
): Promise<'retained' | 'ordinary' | 'ownership-changed' | 'cleanup-pending'> {
  return await writeOwnedDeviceClaim(
    ownership,
    env,
    (claim) => {
      if (!claim.recordingFence) return 'ordinary' as const;
      if (claim.recordingCleanupPending || claim.recordingStartPending)
        return 'cleanup-pending' as const;
      const owner = { pid: ownership.ownerPid, startTime: ownership.ownerStartTime };
      if (claim.recordingSessionOwner && !ownerIdentityMatches(claim.recordingSessionOwner, owner))
        return 'ownership-changed' as const;
      if (!claim.recordingSessionOwner)
        writeDeviceClaim({ ...claim, recordingSessionOwner: owner }, env);
      return 'retained' as const;
    },
    () => 'ownership-changed' as const,
  );
}

export type RecordingAppEventAttempt = Readonly<{
  token: string;
  claim: DeviceClaim;
  previouslyUnresolved: boolean;
  sessionApp: string | undefined;
}>;

/** Fence the event before dispatch, including events that precede recording. */
export async function beginRecordingClaimAppEvent(
  ownership: DeviceClaimSessionOwnership,
  env: EnvMap,
  sessionApp: string | undefined,
): Promise<
  | { status: 'started'; attempt: RecordingAppEventAttempt }
  | { status: 'ordinary' | 'ownership-changed' | 'cleanup-pending' }
> {
  return await writeOwnedDeviceClaim(
    ownership,
    env,
    (claim) => {
      if (
        claim.claimOwnerKind !== 'open-session' &&
        !(claim.claimOwnerKind === 'transient-command' && claim.transientCommand === 'record')
      )
        return { status: 'ordinary' } as const;
      if (claim.recordingCleanupPending || claim.recordingStartPending)
        return { status: 'cleanup-pending' } as const;
      const owner = { pid: ownership.ownerPid, startTime: ownership.ownerStartTime };
      if (claim.recordingSessionOwner && !ownerIdentityMatches(claim.recordingSessionOwner, owner))
        return { status: 'ownership-changed' } as const;
      const token = randomUUID();
      const next: DeviceClaim = {
        ...claim,
        ...(claim.recordingFence
          ? { recordingSessionOwner: claim.recordingSessionOwner ?? owner }
          : {}),
        recordingUnresolvedAppEvent: true,
        recordingAppEventAttempt: token,
      };
      writeDeviceClaim(next, env);
      return {
        status: 'started',
        attempt: {
          token,
          claim: next,
          previouslyUnresolved: !!claim.recordingUnresolvedAppEvent,
          sessionApp,
        },
      } as const;
    },
    () => ({ status: 'ownership-changed' as const }),
  );
}

/** Publish only this dispatch's platform evidence after the request binding has drained. */
export async function settleRecordingClaimAppEvent(
  ownership: DeviceClaimSessionOwnership,
  env: EnvMap,
  attempt: RecordingAppEventAttempt,
  outcome: AppEventDispatchOutcome,
): Promise<'settled' | 'retained' | 'ownership-changed'> {
  if (
    attempt.previouslyUnresolved ||
    !attempt.sessionApp ||
    outcome.kind !== 'session-app-confirmed' ||
    outcome.appBundleId !== attempt.sessionApp ||
    (attempt.claim.recordingAppEventOwner &&
      attempt.claim.recordingAppEventOwner.appBundleId !== outcome.appBundleId)
  )
    return 'retained';
  return await writeOwnedDeviceClaim(
    ownership,
    env,
    (claim) => {
      const prior = attempt.claim;
      if (
        claim.recordingAppEventAttempt !== attempt.token ||
        !claim.recordingUnresolvedAppEvent ||
        claim.recordingCleanupPending ||
        claim.recordingStartPending ||
        claim.session !== prior.session ||
        claim.stateDir !== prior.stateDir ||
        claim.workspace !== prior.workspace ||
        claim.claimOwnerKind !== prior.claimOwnerKind ||
        claim.transientCommand !== prior.transientCommand ||
        !sameDeviceIdentity(claim.device, prior.device) ||
        claim.recordingFence?.token !== prior.recordingFence?.token ||
        claim.recordingFence?.generation !== prior.recordingFence?.generation ||
        !sameOptionalRuntimeOwner(claim.recordingRuntimeOwner, prior.recordingRuntimeOwner) ||
        !sameRecordingSessionOwner(claim.recordingSessionOwner, prior.recordingSessionOwner) ||
        !sameRecordingAppEventOwner(claim.recordingAppEventOwner, prior.recordingAppEventOwner)
      )
        return 'ownership-changed' as const;
      const {
        recordingUnresolvedAppEvent: _,
        recordingAppEventAttempt: _attempt,
        ...settled
      } = claim;
      writeDeviceClaim({ ...settled, recordingAppEventOwner: outcome }, env);
      return 'settled' as const;
    },
    () => 'ownership-changed' as const,
  );
}

function sameOptionalRuntimeOwner(
  left: RuntimeOwnerRef | undefined,
  right: RuntimeOwnerRef | undefined,
) {
  return left && right ? sameRuntimeOwner(left, right) : left === right;
}

/** Retain a promoted recording claim while its owning session and request bindings close. */
export async function holdRecordingClaimForClose(
  ownership: DeviceClaimSessionOwnership,
  env: EnvMap,
  intent: RecordingCloseIntent,
): Promise<
  | {
      status: 'held';
      fence: ResourceOwnershipFence;
      owner: RuntimeOwnerRef;
      sessionOwner: DeviceClaim['recordingSessionOwner'];
      appEventOwner: DeviceClaim['recordingAppEventOwner'];
      intent: RecordingCloseIntent;
      resumed: boolean;
    }
  | {
      status:
        | 'ordinary'
        | 'cleanup-pending'
        | 'ownership-changed'
        | 'close-intent-mismatch'
        | 'unresolved-app-event'
        | 'session-owner-unconfirmed';
    }
> {
  return await writeOwnedDeviceClaim(
    ownership,
    env,
    (claim) => {
      if (
        claim.recordingStartPending ||
        (claim.recordingCleanupPending && !claim.recordingClosePending)
      )
        return { status: 'cleanup-pending' } as const;
      if (
        (claim.claimOwnerKind !== 'open-session' &&
          !(claim.claimOwnerKind === 'transient-command' && claim.transientCommand === 'record')) ||
        !claim.recordingFence
      )
        return { status: 'ordinary' } as const;
      if (claim.recordingUnresolvedAppEvent) return { status: 'unresolved-app-event' } as const;
      if (
        claim.recordingAppEventOwner &&
        intent.positionals[0] !== claim.recordingAppEventOwner.appBundleId
      )
        return { status: 'session-owner-unconfirmed' } as const;
      if (
        intent.appBundleId !== null &&
        claim.device.family !== 'web' &&
        intent.positionals[0] !== intent.appBundleId
      )
        return { status: 'session-owner-unconfirmed' } as const;
      if (!claim.recordingRuntimeOwner) return { status: 'cleanup-pending' } as const;
      if (
        claim.recordingSessionOwner &&
        (!claim.recordingSessionOwner.startTime ||
          !ownerIdentityMatches(claim.recordingSessionOwner, {
            pid: ownership.ownerPid,
            startTime: ownership.ownerStartTime,
          }))
      )
        return { status: 'cleanup-pending' } as const;
      const resumed = claim.recordingClosePending === true;
      if (resumed && !sameRecordingCloseIntent(claim.recordingCloseIntent, intent))
        return { status: 'close-intent-mismatch' } as const;
      if (!resumed)
        writeDeviceClaim(
          {
            ...claim,
            recordingCleanupPending: true,
            recordingClosePending: true,
            recordingCloseIntent: intent,
          },
          env,
        );
      return {
        status: 'held',
        fence: claim.recordingFence,
        owner: claim.recordingRuntimeOwner,
        sessionOwner: claim.recordingSessionOwner,
        appEventOwner: claim.recordingAppEventOwner,
        intent,
        resumed,
      } as const;
    },
    () => ({ status: 'ownership-changed' as const }),
  );
}

/** Finish only the reservation held by this close, after request runtime cleanup settles. */
export async function finishRecordingClaimClose(
  ownership: DeviceClaimSessionOwnership,
  fence: ResourceOwnershipFence,
  owner: RuntimeOwnerRef,
  sessionOwner: DeviceClaim['recordingSessionOwner'],
  appEventOwner: DeviceClaim['recordingAppEventOwner'],
  intent: RecordingCloseIntent,
  env: EnvMap,
  release: boolean,
): Promise<'settled' | 'ownership-changed'> {
  return await writeOwnedDeviceClaim(
    ownership,
    env,
    (claim, claimPath) => {
      if (
        !claim.recordingCleanupPending ||
        !claim.recordingClosePending ||
        claim.recordingUnresolvedAppEvent ||
        !sameRecordingCloseIntent(claim.recordingCloseIntent, intent) ||
        !sameRecordingSessionOwner(claim.recordingSessionOwner, sessionOwner) ||
        !sameRecordingAppEventOwner(claim.recordingAppEventOwner, appEventOwner) ||
        claim.recordingStartPending ||
        claim.recordingFence?.token !== fence.token ||
        claim.recordingFence.generation !== fence.generation ||
        !claim.recordingRuntimeOwner ||
        !sameRuntimeOwner(claim.recordingRuntimeOwner, owner)
      )
        return 'ownership-changed' as const;
      if (release) fs.unlinkSync(claimPath);
      else {
        const {
          recordingCleanupPending: _,
          recordingCleanupProof: _proof,
          recordingClosePending: _close,
          recordingCloseIntent: _intent,
          ...settled
        } = claim;
        writeDeviceClaim(settled, env);
      }
      return 'settled' as const;
    },
    () => 'ownership-changed' as const,
  );
}

function sameRecordingSessionOwner(
  left: DeviceClaim['recordingSessionOwner'],
  right: DeviceClaim['recordingSessionOwner'],
): boolean {
  if (!left || !right) return left === right;
  return Boolean(left.startTime && right.startTime && ownerIdentityMatches(left, right));
}
