import fs from 'node:fs';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  sameRuntimeOwner,
  type ResourceOwnershipFence,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import { ownerIdentityMatches } from '@agent-device/host-kit/process';
import {
  sameRecordingCloseIntent,
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
  effect?: 'app-event',
): Promise<'retained' | 'ordinary' | 'ownership-changed' | 'cleanup-pending'> {
  return await writeOwnedDeviceClaim(
    ownership,
    env,
    (claim) => {
      if (!claim.recordingFence) {
        if (effect === 'app-event' && claim.claimOwnerKind === 'open-session')
          writeDeviceClaim({ ...claim, recordingUnresolvedAppEvent: true }, env);
        return 'ordinary' as const;
      }
      if (claim.recordingCleanupPending || claim.recordingStartPending)
        return 'cleanup-pending' as const;
      const owner = { pid: ownership.ownerPid, startTime: ownership.ownerStartTime };
      if (claim.recordingSessionOwner && !ownerIdentityMatches(claim.recordingSessionOwner, owner))
        return 'ownership-changed' as const;
      if (
        !claim.recordingSessionOwner ||
        (effect === 'app-event' && !claim.recordingUnresolvedAppEvent)
      )
        writeDeviceClaim(
          {
            ...claim,
            recordingSessionOwner: claim.recordingSessionOwner ?? owner,
            ...(effect === 'app-event' ? { recordingUnresolvedAppEvent: true as const } : {}),
          },
          env,
        );
      return 'retained' as const;
    },
    () => 'ownership-changed' as const,
  );
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
