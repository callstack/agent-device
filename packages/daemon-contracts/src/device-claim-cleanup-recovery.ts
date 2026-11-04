import fs from 'node:fs';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { sameDeviceIdentity } from '@agent-device/kernel/device';
import { sameRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import { withDurableCaptureResourceFence } from '@agent-device/capture-kit/durable-capture';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY } from '@agent-device/capture-kit/screen-recording-resource-store';
import { readReplayableStoredCompletion } from '@agent-device/capture-kit/screen-recording-stop-recovery';
import { SCREEN_RECORDING_CLEANUP_SCOPE_METADATA_KEY } from '@agent-device/contracts/screen-recording-runtime';
import { classifyOwnerLiveness, ownerIdentityMatches } from '@agent-device/host-kit/process';
import { inspectDeviceClaimFile } from './device-claim-inspection.ts';
import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import type { DeviceClaim } from './device-claim-record.ts';
import { writeDeviceClaim } from './device-claim-store.ts';

/** Called under the claim locks, before taking the exact recording manifest fence. */
export async function recoverStoppedRecordingCleanup(params: {
  claim: DeviceClaim;
  resourcePath: string;
  env: EnvMap;
}): Promise<'settled' | 'released' | 'unconfirmed'> {
  const { claim } = params;
  if (
    !claim.recordingCleanupProof ||
    !claim.recordingFence ||
    !claim.recordingRuntimeOwner ||
    claim.recordingStartPending
  )
    return 'unconfirmed';
  const liveness = classifyOwnerLiveness({
    owner: { pid: claim.ownerPid, startTime: claim.ownerStartTime },
  });
  if (liveness !== 'owner-process-dead' && liveness !== 'owner-process-reused')
    return 'unconfirmed';
  const record = screenRecordingDurableResource.store.read(params.resourcePath);
  if (record.status !== 'decoded' || !matchesEnvelope(claim, record.envelope)) return 'unconfirmed';
  return await withDurableCaptureResourceFence({
    store: screenRecordingDurableResource.store,
    resourcePath: params.resourcePath,
    expected: claim.recordingFence,
    onCompleted: ({ envelope }) => settle(envelope, true),
    run: async (lease) => settle(lease.envelope, false),
  });

  function settle(
    envelope: DurableResourceEnvelope<'screen-recording'>,
    completed: boolean,
  ): 'settled' | 'released' | 'unconfirmed' {
    const current = inspectDeviceClaimFile(
      resolveDeviceClaimPath(claim.deviceKey, params.env),
    )?.claim;
    if (!current || !sameClaim(current, claim) || !matchesEnvelope(current, envelope))
      return 'unconfirmed';
    if (current.recordingCleanupProof === 'stop-prepared') {
      if (completed) return 'unconfirmed';
    } else if (!completed || !readReplayableStoredCompletion(envelope.metadata)) {
      return 'unconfirmed';
    }
    if (
      current.recordingCleanupProof === 'stop-drained-release' ||
      current.recordingCleanupProof === 'stop-completed-release'
    ) {
      if (current.claimOwnerKind !== 'transient-command' || current.transientCommand !== 'record')
        return 'unconfirmed';
      fs.unlinkSync(resolveDeviceClaimPath(current.deviceKey, params.env));
      return 'released';
    }
    if (
      (current.recordingCleanupProof === 'stop-drained-retain' ||
        current.recordingCleanupProof === 'stop-completed-retain') &&
      current.claimOwnerKind === 'transient-command' &&
      current.transientCommand === 'record'
    ) {
      const {
        recordingCleanupPending: _,
        recordingCleanupProof: _proof,
        transientCommand: _command,
        ...settled
      } = current;
      writeDeviceClaim({ ...settled, claimOwnerKind: 'open-session' }, params.env);
      return 'settled';
    }
    const { recordingCleanupPending: _, recordingCleanupProof: _proof, ...settled } = current;
    writeDeviceClaim(settled, params.env);
    return 'settled';
  }
}

function matchesEnvelope(
  claim: DeviceClaim,
  envelope: DurableResourceEnvelope<'screen-recording'>,
): boolean {
  return Boolean(
    claim.recordingFence &&
    claim.recordingRuntimeOwner &&
    envelope.sessionId === claim.session &&
    sameDeviceIdentity(envelope.device, claim.device) &&
    envelope.fence.token === claim.recordingFence.token &&
    envelope.fence.generation === claim.recordingFence.generation &&
    sameRuntimeOwner(envelope.owner, claim.recordingRuntimeOwner) &&
    envelope.metadata?.[SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY] === claim.ownerToken &&
    envelope.metadata?.[SCREEN_RECORDING_CLEANUP_SCOPE_METADATA_KEY] === 'local-drained',
  );
}

function sameClaim(current: DeviceClaim, expected: DeviceClaim): boolean {
  return Boolean(
    current.recordingCleanupPending &&
    current.recordingCleanupProof === expected.recordingCleanupProof &&
    !current.recordingStartPending &&
    current.deviceKey === expected.deviceKey &&
    current.stateDir === expected.stateDir &&
    current.workspace === expected.workspace &&
    current.session === expected.session &&
    current.claimOwnerKind === expected.claimOwnerKind &&
    current.transientCommand === expected.transientCommand &&
    current.ownerToken === expected.ownerToken &&
    current.abandonedAtMs === expected.abandonedAtMs &&
    sameDeviceIdentity(current.device, expected.device) &&
    ownerIdentityMatches(
      { pid: current.ownerPid, startTime: current.ownerStartTime },
      { pid: expected.ownerPid, startTime: expected.ownerStartTime },
    ) &&
    current.recordingFence?.token === expected.recordingFence?.token &&
    current.recordingFence?.generation === expected.recordingFence?.generation &&
    current.recordingRuntimeOwner &&
    expected.recordingRuntimeOwner &&
    sameRuntimeOwner(current.recordingRuntimeOwner, expected.recordingRuntimeOwner),
  );
}
