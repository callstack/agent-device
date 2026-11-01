import type Limrun from '@limrun/api';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { LIMRUN_PROVIDER, platformForLimrunLeaseBackend } from './device.ts';
import type { LimrunDisposalOutcome } from './lease-ownership.ts';

/**
 * The route that ends one lease: the release a caller asked for, or the recovery of a lease this runtime lost
 * sight of. Both answer for the same thing — what the lease has running, and whether it stopped — and neither
 * reports a lease as released on anything short of Limrun confirming the delete.
 */

/** What a release answers for one lease: the instance it ended, with what it left and wrote. */
type LimrunReleaseRecord = Record<string, unknown>;

/**
 * Ends one lease from the disposal its runtime already started for it, or from what the lease's own labels
 * name when the runtime no longer holds an owner for it. A delete Limrun did not confirm keeps the lease held:
 * the release is refused, and the next release, recovery or shutdown retries the same instance rather than
 * reporting an instance released.
 *
 * The disposal is handed in rather than started here because the caller took the lease in the same step the
 * release was asked for, and no loading in between may let the allocation still waiting on its create answer
 * first.
 */
export async function releaseLimrunLease(
  limrun: Limrun | undefined,
  lease: DeviceLease,
  disposal: Promise<LimrunDisposalOutcome> | undefined,
): Promise<LimrunReleaseRecord | undefined> {
  // No disposal means this runtime holds nothing for the lease: it was never allocated here, or its disposal
  // confirmed and gave it back. What the lease has under its labels is the recovery route's.
  if (disposal === undefined) return await releaseLabeledInstances(limrun, lease);
  const outcome = await disposal;
  if (outcome.cleanup === 'uncertain') throw releaseLeftInstanceRunning(lease.leaseId, outcome);
  if (outcome.instanceId === undefined) return undefined;
  const { networkArtifacts } = await import('./network-har.ts');
  return {
    limrunInstanceId: outcome.instanceId,
    // The instance is gone, so the lease is released; what the release stopped waiting for is a warning the
    // caller still has to see, because it is a host resource this process left behind.
    ...(outcome.failure === undefined
      ? {}
      : {
          warnings: [
            {
              code: 'LIMRUN_TEARDOWN_INCOMPLETE',
              message: outcome.failure,
              limrunInstanceId: outcome.instanceId,
            },
          ],
        }),
    ...(outcome.capture ? { cloudArtifacts: networkArtifacts(outcome.capture) } : {}),
  };
}

/** Ends every instance a lease's own labels name, for a lease this runtime no longer holds an owner for. */
async function releaseLabeledInstances(
  limrun: Limrun | undefined,
  lease: DeviceLease,
): Promise<LimrunReleaseRecord | undefined> {
  const platform = platformForLimrunLeaseBackend(lease.backend);
  if (!platform || !limrun) return undefined;
  const labelSelector = `provider=${LIMRUN_PROVIDER},leaseId=${lease.leaseId}`;
  const instances =
    platform === 'ios'
      ? await limrun.iosInstances.list({ labelSelector })
      : await limrun.androidInstances.list({ labelSelector });
  const instanceIds = instances.getPaginatedItems().map((instance) => instance.metadata.id);
  for (const instanceId of instanceIds) {
    if (platform === 'ios') {
      await limrun.iosInstances.delete(instanceId);
    } else {
      await limrun.androidInstances.delete(instanceId);
    }
  }
  if (instanceIds.length === 0) return undefined;
  return { limrunInstanceId: instanceIds[0], limrunInstanceCount: instanceIds.length };
}

/** What a release reports when Limrun did not confirm the delete, so the lease is still held. */
function releaseLeftInstanceRunning(leaseId: string, outcome: LimrunDisposalOutcome): never {
  throw new AppError(
    'COMMAND_FAILED',
    `Limrun instance for lease '${leaseId}' was not confirmed deleted`,
    {
      reason: 'limrun_instance_delete_unconfirmed',
      retriable: true,
      ...(outcome.instanceId === undefined ? {} : { limrunInstanceId: outcome.instanceId }),
      ...(outcome.failure === undefined ? {} : { cause: outcome.failure }),
      hint: `Release lease '${leaseId}' again, or ask Limrun to delete instance '${outcome.instanceId ?? leaseId}'.`,
    },
  );
}
