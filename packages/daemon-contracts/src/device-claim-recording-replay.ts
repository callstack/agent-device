import path from 'node:path';
import { sameDeviceIdentity, hostDeviceIdOf } from '@agent-device/kernel/device';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { sameRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { withDurableCaptureResourceFence } from '@agent-device/capture-kit/durable-capture';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { readPendingScreenRecordingCompletion } from '@agent-device/capture-kit/screen-recording-stop-recovery';
import { SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY } from '@agent-device/capture-kit/screen-recording-resource-store';
import { ownerIdentityMatches } from '@agent-device/host-kit/process';
import { inspectDeviceClaimFile, inspectDeviceClaims } from './device-claim-inspection.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from './device-claim-paths.ts';
import type { DeviceClaim } from './device-claim-record.ts';
import { withDeviceClaimLock } from './device-claim-store.ts';

export type PendingRecordingReplay = Readonly<{
  completion: ScreenRecordingCompletion;
  remoteOutput: boolean;
  tenantId?: string;
}>;

type ReplayContext = Readonly<{
  session: string;
  stateDir: string;
  resourcePath: string;
  env: EnvMap;
  workspaceMatches(workspace: string): boolean;
}>;

function matches(claim: DeviceClaim, params: ReplayContext): boolean {
  return Boolean(
    claim.recordingCleanupPending &&
    !claim.recordingStartPending &&
    claim.abandonedAtMs === undefined &&
    claim.session === params.session &&
    path.resolve(claim.stateDir) === path.resolve(params.stateDir) &&
    params.workspaceMatches(claim.workspace) &&
    claim.recordingFence &&
    claim.recordingRuntimeOwner,
  );
}

/** Read a preserved output under its exact claim and manifest fences; this never settles cleanup. */
export async function readPendingRecordingReplay(
  params: ReplayContext,
): Promise<PendingRecordingReplay | undefined> {
  const entries = inspectDeviceClaims({}, params.env);
  if (entries.some((entry) => !entry.claim)) return undefined;
  const matching = entries.flatMap((entry) =>
    entry.claim && matches(entry.claim, params) ? [entry.claim] : [],
  );
  if (matching.length !== 1) return undefined;
  const scanned = matching[0]!;
  const hostId = hostDeviceIdOf(scanned.device.id);
  const hostKey =
    hostId === scanned.device.id
      ? undefined
      : canonicalLocalDeviceKey({ ...scanned.device, id: hostId });
  const read = async () => {
    const claim = inspectDeviceClaimFile(
      resolveDeviceClaimPath(scanned.deviceKey, params.env),
    )?.claim;
    if (
      !claim ||
      !matches(claim, params) ||
      claim.ownerToken !== scanned.ownerToken ||
      !ownerIdentityMatches(
        { pid: claim.ownerPid, startTime: claim.ownerStartTime },
        { pid: scanned.ownerPid, startTime: scanned.ownerStartTime },
      ) ||
      claim.recordingFence?.token !== scanned.recordingFence?.token ||
      claim.recordingFence?.generation !== scanned.recordingFence?.generation
    )
      return undefined;
    return await readPendingRecordingReplayUnderLock(claim, params.resourcePath);
  };
  if (!hostKey) return await withDeviceClaimLock(scanned.deviceKey, params.env, read);
  return await withDeviceClaimLock(hostKey, params.env, async () => {
    if (inspectDeviceClaimFile(resolveDeviceClaimPath(hostKey, params.env))) return undefined;
    return await withDeviceClaimLock(scanned.deviceKey, params.env, read);
  });
}

/** The caller already holds the exact claim locks. */
export async function readPendingRecordingReplayUnderLock(
  claim: DeviceClaim,
  resourcePath: string,
): Promise<PendingRecordingReplay | undefined> {
  if (!claim.recordingCleanupPending || !claim.recordingFence || !claim.recordingRuntimeOwner)
    return undefined;
  return await withDurableCaptureResourceFence({
    store: screenRecordingDurableResource.store,
    resourcePath,
    expected: claim.recordingFence,
    onCompleted: () => undefined,
    run: async ({ envelope }) => {
      if (
        envelope.sessionId !== claim.session ||
        !sameDeviceIdentity(envelope.device, claim.device) ||
        !claim.recordingRuntimeOwner ||
        !sameRuntimeOwner(envelope.owner, claim.recordingRuntimeOwner) ||
        envelope.metadata?.[SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY] !== claim.ownerToken
      )
        return undefined;
      const completion = readPendingScreenRecordingCompletion(envelope.metadata);
      if (!completion) return undefined;
      const tenantId = envelope.metadata?.remoteCaptureTenantId;
      return {
        completion,
        remoteOutput: envelope.metadata?.remoteCaptureOutput === true,
        ...(typeof tenantId === 'string' ? { tenantId } : {}),
      };
    },
  });
}
