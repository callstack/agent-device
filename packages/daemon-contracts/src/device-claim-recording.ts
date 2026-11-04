import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { sameDeviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  sameRuntimeOwner,
  type RuntimeOwnerRef,
  type ResourceOwnershipFence,
} from '@agent-device/contracts/platform-runtime';
import { withDurableCaptureResourceFence } from '@agent-device/capture-kit/durable-capture';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY as CLAIM_TOKEN } from '@agent-device/capture-kit/screen-recording-resource-store';
import {
  classifyOwnerLiveness,
  ownerIdentityMatches,
  readCurrentOwnerIdentity,
} from '@agent-device/host-kit/process';
import { inspectDeviceClaimFile } from './device-claim-inspection.ts';
import {
  canonicalLocalDeviceKey,
  deviceClaimIdentity,
  resolveDeviceClaimPath,
} from './device-claim-paths.ts';
import {
  ownershipFromClaim,
  type DeviceClaim,
  type DeviceClaimSessionOwnership,
} from './device-claim-record.ts';
import {
  acquireDeviceClaimLock,
  withDeviceClaimLock,
  writeDeviceClaim,
} from './device-claim-store.ts';
import { inspectDeviceClaimRecovery } from './device-claim-reconciliation.ts';

type RecordingClaimContext = {
  device: DeviceInfo;
  session: string;
  workspace: string;
  stateDir: string;
  resourcePath: string;
  env: EnvMap;
};

async function withRecordingClaimLocks<T>(
  params: RecordingClaimContext,
  run: (key: string) => Promise<T>,
): Promise<T> {
  const key = canonicalLocalDeviceKey(deviceClaimIdentity(params.device));
  const hostId = params.device.hostApp?.hostDeviceId;
  if (hostId === undefined) return await withDeviceClaimLock(key, params.env, () => run(key));
  const hostKey = canonicalLocalDeviceKey(
    deviceClaimIdentity({ ...params.device, id: hostId, hostApp: undefined }),
  );
  return await withDeviceClaimLock(hostKey, params.env, async () => {
    if (inspectDeviceClaimFile(resolveDeviceClaimPath(hostKey, params.env))) throw claimError();
    return await withDeviceClaimLock(key, params.env, () => run(key));
  });
}

function claimError(): AppError {
  return new AppError('DEVICE_IN_USE', 'The recording device claim cannot be transferred', {
    reason: 'DEVICE_CLAIM_OWNER_UNCERTAIN',
    retriable: false,
  });
}

function matchesContext(claim: DeviceClaim, params: RecordingClaimContext): boolean {
  return (
    claim.abandonedAtMs === undefined &&
    claim.session === params.session &&
    path.resolve(claim.stateDir) === path.resolve(params.stateDir) &&
    path.resolve(claim.workspace) === path.resolve(params.workspace) &&
    sameDeviceIdentity(claim.device, deviceClaimIdentity(params.device))
  );
}

/** Transfer only the exact claim of an open recording, while holding claim locks before its fence. */
export async function admitRecordingStop(
  params: RecordingClaimContext & { owner: RuntimeOwnerRef },
) {
  const key = canonicalLocalDeviceKey(deviceClaimIdentity(params.device));
  const hostId = params.device.hostApp?.hostDeviceId;
  const hostKey =
    hostId === undefined
      ? undefined
      : canonicalLocalDeviceKey(
          deviceClaimIdentity({ ...params.device, id: hostId, hostApp: undefined }),
        );
  const hostLock =
    hostKey === undefined ? undefined : await acquireDeviceClaimLock(hostKey, params.env);
  let deviceLock: Awaited<ReturnType<typeof acquireDeviceClaimLock>> | undefined;
  try {
    if (hostKey && inspectDeviceClaimFile(resolveDeviceClaimPath(hostKey, params.env)))
      throw claimError();
    deviceLock = await acquireDeviceClaimLock(key, params.env);

    const inspected = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env));
    const claim = inspected?.claim;
    if (!claim || !matchesContext(claim, params)) throw claimError();
    const owner = readCurrentOwnerIdentity();
    const current = ownerIdentityMatches(
      { pid: claim.ownerPid, startTime: claim.ownerStartTime },
      owner,
    );
    if (
      claim.claimOwnerKind !== 'open-session' &&
      !(claim.claimOwnerKind === 'transient-command' && claim.transientCommand === 'record')
    )
      throw claimError();
    if (!current) {
      const liveness = classifyOwnerLiveness({
        owner: { pid: claim.ownerPid, startTime: claim.ownerStartTime },
      });
      if (liveness !== 'owner-process-dead' && liveness !== 'owner-process-reused')
        throw claimError();
      const resources = inspectDeviceClaimRecovery(claim);
      if (
        resources.status !== 'inspectable' ||
        resources.recoveryKinds.some((kind) => kind !== 'screen-recording')
      )
        throw claimError();
    }
    const record = screenRecordingDurableResource.store.read(params.resourcePath);
    if (record.status !== 'decoded' || record.envelope.lifecycle !== 'open') throw claimError();
    const expected = record.envelope;
    const admitted = await withDurableCaptureResourceFence({
      store: screenRecordingDurableResource.store,
      resourcePath: params.resourcePath,
      expected: expected.fence,
      onCompleted: () => {
        throw claimError();
      },
      run: async (lease) => {
        const envelope = lease.envelope;
        const recordedToken = envelope.metadata?.[CLAIM_TOKEN];
        if (
          envelope.sessionId !== claim.session ||
          !sameDeviceIdentity(envelope.device, claim.device) ||
          !sameRuntimeOwner(envelope.owner, expected.owner) ||
          !sameRuntimeOwner(envelope.owner, params.owner) ||
          (recordedToken !== undefined && recordedToken !== claim.ownerToken) ||
          (claim.claimOwnerKind === 'transient-command' &&
            (recordedToken !== claim.ownerToken ||
              claim.recordingFence?.token !== envelope.fence.token ||
              claim.recordingFence.generation !== envelope.fence.generation))
        )
          throw claimError();
        if (recordedToken === undefined) {
          lease.transition('open', {
            metadata: { ...envelope.metadata, [CLAIM_TOKEN]: claim.ownerToken },
          });
        }
        if (current && claim.claimOwnerKind === 'open-session')
          return { status: 'covered' as const };
        const transferred: DeviceClaim = {
          ...claim,
          ownerPid: owner.pid,
          ownerStartTime: owner.startTime,
          claimOwnerKind: 'transient-command',
          transientCommand: 'record',
          recordingFence: envelope.fence,
          updatedAtMs: Date.now(),
        };
        writeDeviceClaim(transferred, params.env);
        return { status: 'reserved' as const, ownership: ownershipFromClaim(transferred) };
      },
    });
    const ownership =
      admitted.status === 'reserved' ? admitted.ownership : ownershipFromClaim(claim);
    const lock = deviceLock;
    return {
      ...admitted,
      assertCurrent: () => {
        hostLock?.assertHeld();
        lock.assertHeld();
        const current = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env))?.claim;
        if (
          !current ||
          !matchesContext(current, params) ||
          current.ownerToken !== ownership.ownerToken ||
          (admitted.status === 'reserved' &&
            (current.recordingFence?.token !== expected.fence.token ||
              current.recordingFence.generation !== expected.fence.generation)) ||
          !ownerIdentityMatches(
            { pid: current.ownerPid, startTime: current.ownerStartTime },
            { pid: ownership.ownerPid, startTime: ownership.ownerStartTime },
          )
        )
          throw claimError();
      },
      finish: async (input: RecordingClaimFinish) => {
        try {
          return admitted.status === 'reserved'
            ? await finishRecordingClaimUnderLock(
                { ...params, ...input, ownership, expectedOwner: expected.owner },
                key,
              )
            : false;
        } finally {
          try {
            await lock.release();
          } finally {
            await hostLock?.release();
          }
        }
      },
    };
  } catch (error) {
    try {
      await deviceLock?.release();
    } finally {
      await hostLock?.release();
    }
    throw error;
  }
}

/** Publish the new generation before its native start can run. */
export async function reserveRecordingClaimFence(
  params: RecordingClaimContext & {
    ownership: DeviceClaimSessionOwnership;
    fence: ResourceOwnershipFence;
  },
): Promise<void> {
  await withRecordingClaimLocks(params, async (key) => {
    const claim = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env))?.claim;
    if (
      !claim ||
      !matchesContext(claim, params) ||
      claim.claimOwnerKind !== 'transient-command' ||
      claim.transientCommand !== 'record' ||
      claim.ownerToken !== params.ownership.ownerToken ||
      !ownerIdentityMatches(
        { pid: claim.ownerPid, startTime: claim.ownerStartTime },
        { pid: params.ownership.ownerPid, startTime: params.ownership.ownerStartTime },
      )
    )
      throw claimError();
    writeDeviceClaim(
      { ...claim, recordingFence: params.fence, updatedAtMs: Date.now() },
      params.env,
    );
  });
}

/** Release a confirmed rollback or completed reservation after request cleanup. */
type RecordingClaimFinish = {
  action: 'start' | 'stop';
  succeeded: boolean;
  runtimeDisposed: boolean;
  startAttempted: boolean;
};

export async function finishRecordingClaimRequest(
  params: RecordingClaimContext &
    RecordingClaimFinish & {
      ownership: DeviceClaimSessionOwnership;
    },
): Promise<boolean> {
  return await withRecordingClaimLocks(
    params,
    async (key) => await finishRecordingClaimUnderLock(params, key),
  );
}

async function finishRecordingClaimUnderLock(
  params: RecordingClaimContext &
    RecordingClaimFinish & {
      ownership: DeviceClaimSessionOwnership;
      expectedOwner?: RuntimeOwnerRef;
    },
  key: string,
): Promise<boolean> {
  const claim = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env))?.claim;
  if (
    !claim ||
    !matchesContext(claim, params) ||
    claim.ownerToken !== params.ownership.ownerToken ||
    !ownerIdentityMatches(
      { pid: claim.ownerPid, startTime: claim.ownerStartTime },
      { pid: params.ownership.ownerPid, startTime: params.ownership.ownerStartTime },
    )
  )
    return false;
  if (!params.runtimeDisposed) return false;
  const record = screenRecordingDurableResource.store.read(params.resourcePath);
  if (record.status === 'missing') {
    if (params.action === 'start' && !params.succeeded && !params.startAttempted) {
      fs.unlinkSync(resolveDeviceClaimPath(key, params.env));
      return true;
    }
    return false;
  }
  if (record.status !== 'decoded') return false;
  const expected = record.envelope;
  return await withDurableCaptureResourceFence({
    store: screenRecordingDurableResource.store,
    resourcePath: params.resourcePath,
    expected: expected.fence,
    onCompleted: ({ envelope }) => {
      if (
        envelope.sessionId !== claim.session ||
        !sameDeviceIdentity(envelope.device, claim.device)
      )
        return false;
      const token = envelope.metadata?.[CLAIM_TOKEN];
      if (
        (params.action === 'stop' &&
          params.succeeded &&
          token === claim.ownerToken &&
          claim.recordingFence?.token === envelope.fence.token &&
          claim.recordingFence.generation === envelope.fence.generation &&
          params.expectedOwner !== undefined &&
          sameRuntimeOwner(envelope.owner, params.expectedOwner)) ||
        (params.action === 'start' &&
          !params.succeeded &&
          (!params.startAttempted ||
            (token === claim.ownerToken &&
              envelope.metadata?.cleanupStatus === 'cleaned' &&
              claim.recordingFence?.token === envelope.fence.token &&
              claim.recordingFence.generation === envelope.fence.generation)))
      ) {
        fs.unlinkSync(resolveDeviceClaimPath(key, params.env));
        return true;
      }
      return false;
    },
    run: async () => false,
  });
}
