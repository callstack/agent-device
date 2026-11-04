import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  sameDeviceIdentity,
  type DeviceInfo,
  type DeviceIdentity,
} from '@agent-device/kernel/device';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import {
  sameRuntimeOwner,
  type RuntimeOwnerRef,
  type ResourceOwnershipFence,
  type DeviceRuntimeGateway,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { withDurableCaptureResourceFence } from '@agent-device/capture-kit/durable-capture';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import {
  SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY as CLAIM_TOKEN,
  SCREEN_RECORDING_CLAIM_BINDING_VERSION_KEY as CLAIM_BINDING_VERSION,
} from '@agent-device/capture-kit/screen-recording-resource-store';
import {
  classifyOwnerLiveness,
  ownerIdentityMatches,
  readCurrentOwnerIdentity,
} from '@agent-device/host-kit/process';
import { inspectDeviceClaimFile, inspectDeviceClaims } from './device-claim-inspection.ts';
import { resolveDeviceClaimRoot } from '@agent-device/host-kit/file';
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
import {
  inspectDeviceClaimRecovery,
  isIncompleteRecordingStartClaim,
  recoverIncompleteRecordingClaim,
} from './device-claim-reconciliation.ts';
import {
  beginIncompleteStartRecoveryCleanup,
  finishIncompleteStartRecoveryCleanup,
} from './device-claim-settlement.ts';

type RecordingClaimContext = {
  device: DeviceInfo;
  session: string;
  workspace: string;
  stateDir: string;
  resourcePath: string;
  workspaceMatches(workspace: string): boolean;
  env: EnvMap;
};

/** Locate only a unique recorded reservation; claim admission revalidates it under locks. */
export function findIncompleteRecordingReservation(params: {
  session: string;
  stateDir: string;
  workspaceMatches(workspace: string): boolean;
  env: EnvMap;
}): DeviceIdentity | undefined {
  const root = resolveDeviceClaimRoot(params.env);
  const entries = inspectDeviceClaims({}, params.env);
  if (entries.some((entry) => !entry.claim)) throw claimError();
  const matches = entries.flatMap((entry) => {
    const claim = entry.claim!;
    if (
      !claim.recordingStartPending ||
      !claim.recordingFence ||
      !claim.recordingRuntimeOwner ||
      claim.abandonedAtMs !== undefined ||
      claim.session !== params.session ||
      path.resolve(claim.stateDir) !== path.resolve(params.stateDir) ||
      !params.workspaceMatches(claim.workspace) ||
      !(
        claim.claimOwnerKind === 'open-session' ||
        (claim.claimOwnerKind === 'transient-command' && claim.transientCommand === 'record')
      )
    )
      return [];
    if (resolveDeviceClaimPath(claim.deviceKey, params.env) !== path.join(root, entry.fileName))
      throw claimError();
    return [claim.device];
  });
  if (matches.length > 1) throw claimError();
  return matches[0];
}

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
    params.workspaceMatches(claim.workspace) &&
    sameDeviceIdentity(claim.device, deviceClaimIdentity(params.device))
  );
}

/** Transfer only the exact claim of an open recording, while holding claim locks before its fence. */
export async function admitRecordingStop(
  params: RecordingClaimContext & {
    owner: RuntimeOwnerRef;
    sessionOwnership?: DeviceClaimSessionOwnership;
  },
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
    if (!claim || !matchesContext(claim, params) || claim.recordingCleanupPending)
      throw claimError();
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
    if (
      current &&
      claim.claimOwnerKind === 'open-session' &&
      (!params.sessionOwnership ||
        params.sessionOwnership.deviceKey !== claim.deviceKey ||
        params.sessionOwnership.ownerToken !== claim.ownerToken ||
        !ownerIdentityMatches(
          { pid: claim.ownerPid, startTime: claim.ownerStartTime },
          {
            pid: params.sessionOwnership.ownerPid,
            startTime: params.sessionOwnership.ownerStartTime,
          },
        ))
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
          recordedToken !== claim.ownerToken ||
          claim.recordingFence?.token !== envelope.fence.token ||
          claim.recordingFence.generation !== envelope.fence.generation ||
          !claim.recordingRuntimeOwner ||
          !sameRuntimeOwner(claim.recordingRuntimeOwner, envelope.owner)
        )
          throw claimError();
        const covered = current && claim.claimOwnerKind === 'open-session';
        const transferred: DeviceClaim = {
          ...claim,
          ...(covered
            ? {}
            : {
                ownerPid: owner.pid,
                ownerStartTime: owner.startTime,
                claimOwnerKind: 'transient-command' as const,
                transientCommand: 'record',
              }),
          recordingFence: envelope.fence,
          recordingRuntimeOwner: envelope.owner,
          recordingCleanupPending: true,
          updatedAtMs: Date.now(),
        };
        writeDeviceClaim(transferred, params.env);
        return {
          status: covered ? ('covered' as const) : ('reserved' as const),
          ownership: ownershipFromClaim(transferred),
        };
      },
    });
    const ownership = admitted.ownership;
    const lock = deviceLock;
    return {
      ...admitted,
      fence: expected.fence,
      owner: expected.owner,
      assertCurrent: () => {
        hostLock?.assertHeld();
        lock.assertHeld();
        const current = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env))?.claim;
        if (
          !current ||
          !matchesContext(current, params) ||
          current.ownerToken !== ownership.ownerToken ||
          current.recordingFence?.token !== expected.fence.token ||
          current.recordingFence.generation !== expected.fence.generation ||
          !current.recordingCleanupPending ||
          !ownerIdentityMatches(
            { pid: current.ownerPid, startTime: current.ownerStartTime },
            { pid: ownership.ownerPid, startTime: ownership.ownerStartTime },
          )
        )
          throw claimError();
      },
      finish: async (input: RecordingClaimFinish) => {
        try {
          return await finishRecordingClaimUnderLock(
            {
              ...params,
              ...input,
              ownership,
              expectedOwner: expected.owner,
              releaseWhenComplete: admitted.status === 'reserved',
            },
            key,
          );
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
    owner: RuntimeOwnerRef;
  },
): Promise<void> {
  await withRecordingClaimLocks(params, async (key) => {
    const claim = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env))?.claim;
    if (
      !claim ||
      !matchesContext(claim, params) ||
      params.owner.kind !== 'local-family' ||
      params.owner.family !== claim.device.family ||
      !(
        claim.claimOwnerKind === 'open-session' ||
        (claim.claimOwnerKind === 'transient-command' && claim.transientCommand === 'record')
      ) ||
      claim.ownerToken !== params.ownership.ownerToken ||
      !ownerIdentityMatches(
        { pid: claim.ownerPid, startTime: claim.ownerStartTime },
        { pid: params.ownership.ownerPid, startTime: params.ownership.ownerStartTime },
      )
    )
      throw claimError();
    writeDeviceClaim(
      {
        ...claim,
        recordingFence: params.fence,
        recordingRuntimeOwner: params.owner,
        recordingCleanupPending: true,
        recordingStartPending: true,
        updatedAtMs: Date.now(),
      },
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
  retainForSession?: boolean;
  startProof?: 'not-dispatched' | 'rolled-back';
  startFence?: ResourceOwnershipFence;
  expectedOwner?: RuntimeOwnerRef;
  releaseWhenComplete?: boolean;
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
  if (
    params.action === 'start' &&
    !params.succeeded &&
    !params.startProof &&
    params.startAttempted &&
    params.startFence &&
    claim.recordingFence?.token === params.startFence.token &&
    claim.recordingFence.generation === params.startFence.generation
  ) {
    const { recordingCleanupPending: _, ...settled } = claim;
    writeDeviceClaim(settled, params.env);
    return false;
  }
  if (
    params.action === 'start' &&
    !params.succeeded &&
    params.startProof &&
    params.startFence &&
    claim.recordingFence?.token === params.startFence.token &&
    claim.recordingFence.generation === params.startFence.generation
  ) {
    if (
      record.status === 'decoded' &&
      record.envelope.fence.token === params.startFence.token &&
      record.envelope.fence.generation === params.startFence.generation &&
      record.envelope.lifecycle === 'open'
    ) {
      await withDurableCaptureResourceFence({
        store: screenRecordingDurableResource.store,
        resourcePath: params.resourcePath,
        expected: params.startFence,
        onCompleted: () => {},
        run: async (lease) => {
          if (
            lease.envelope.sessionId !== claim.session ||
            !sameDeviceIdentity(lease.envelope.device, claim.device) ||
            !params.expectedOwner ||
            !sameRuntimeOwner(lease.envelope.owner, params.expectedOwner)
          )
            throw claimError();
          lease.transition('completed', {
            metadata: {
              ...lease.envelope.metadata,
              [CLAIM_TOKEN]: claim.ownerToken,
              [CLAIM_BINDING_VERSION]: 1,
              phase: 'completed',
              cleanupStatus: 'cleaned',
            },
          });
        },
      });
    }
    if (params.releaseWhenComplete !== false) {
      fs.unlinkSync(resolveDeviceClaimPath(key, params.env));
      return true;
    }
    const { recordingCleanupPending: _, recordingStartPending: _start, ...settled } = claim;
    writeDeviceClaim(settled, params.env);
    return false;
  }
  if (record.status === 'missing') {
    if (
      params.action === 'start' &&
      !params.succeeded &&
      !params.startAttempted &&
      params.releaseWhenComplete !== false
    ) {
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
        params.action === 'stop' &&
        params.succeeded &&
        token === claim.ownerToken &&
        claim.recordingFence?.token === envelope.fence.token &&
        claim.recordingFence.generation === envelope.fence.generation &&
        params.expectedOwner !== undefined &&
        sameRuntimeOwner(envelope.owner, params.expectedOwner)
      ) {
        if (params.releaseWhenComplete && params.retainForSession) {
          const { recordingCleanupPending: _, transientCommand: _command, ...rest } = claim;
          writeDeviceClaim({ ...rest, claimOwnerKind: 'open-session' }, params.env);
          return false;
        }
        if (params.releaseWhenComplete) {
          fs.unlinkSync(resolveDeviceClaimPath(key, params.env));
          return true;
        }
        const { recordingCleanupPending: _, ...settled } = claim;
        writeDeviceClaim(settled, params.env);
        return false;
      }
      if (
        params.action === 'start' &&
        params.releaseWhenComplete !== false &&
        !params.succeeded &&
        (!params.startAttempted ||
          (token === claim.ownerToken &&
            envelope.metadata?.cleanupStatus === 'cleaned' &&
            claim.recordingFence?.token === envelope.fence.token &&
            claim.recordingFence.generation === envelope.fence.generation))
      ) {
        fs.unlinkSync(resolveDeviceClaimPath(key, params.env));
        return true;
      }
      return false;
    },
    run: async (lease) => {
      if (
        params.action === 'start' &&
        params.succeeded &&
        lease.envelope.metadata?.[CLAIM_TOKEN] === claim.ownerToken &&
        claim.recordingFence?.token === lease.envelope.fence.token &&
        claim.recordingFence.generation === lease.envelope.fence.generation &&
        params.expectedOwner &&
        sameRuntimeOwner(lease.envelope.owner, params.expectedOwner)
      ) {
        const { recordingCleanupPending: _, recordingStartPending: _start, ...settled } = claim;
        writeDeviceClaim(settled, params.env);
      }
      if (
        params.action === 'stop' &&
        !params.succeeded &&
        lease.envelope.metadata?.[CLAIM_TOKEN] === claim.ownerToken &&
        claim.recordingFence?.token === lease.envelope.fence.token &&
        claim.recordingFence.generation === lease.envelope.fence.generation &&
        params.expectedOwner &&
        sameRuntimeOwner(lease.envelope.owner, params.expectedOwner)
      ) {
        const { recordingCleanupPending: _, ...settled } = claim;
        writeDeviceClaim(settled, params.env);
      }
      return false;
    },
  });
}

export type RetainedRecordingCleanup = Readonly<{
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  ownership: DeviceClaimSessionOwnership;
  purpose: 'start' | 'stop' | 'close';
  startProof?: 'not-dispatched' | 'rolled-back';
  releaseWhenComplete?: boolean;
  retry(): Promise<void>;
}>;

/** Retry only the cleanup authority captured by the request that held this exact claim. */
export async function retryRecordingClaimCleanup(
  params: RecordingClaimContext & {
    retained?: RetainedRecordingCleanup;
    retainForSession?: (ownership: DeviceClaimSessionOwnership) => boolean;
  },
): Promise<'none' | 'settled' | 'released'> {
  if (!params.retained) {
    const key = canonicalLocalDeviceKey(deviceClaimIdentity(params.device));
    const current = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env))?.claim;
    if (!current || !matchesContext(current, params) || !current.recordingCleanupPending)
      return 'none';
  }
  return await withRecordingClaimLocks(params, async (key) => {
    const claim = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env))?.claim;
    if (!claim || !matchesContext(claim, params) || !claim.recordingCleanupPending) {
      if (params.retained) throw claimError();
      return 'none';
    }
    const retained = params.retained;
    if (!retained) throw cleanupPendingError();
    const current = readCurrentOwnerIdentity();
    if (
      claim.ownerToken !== retained.ownership.ownerToken ||
      !sameDeviceIdentity(
        deviceClaimIdentity(retained.device),
        deviceClaimIdentity(params.device),
      ) ||
      !ownerIdentityMatches({ pid: claim.ownerPid, startTime: claim.ownerStartTime }, current) ||
      !ownerIdentityMatches(
        { pid: claim.ownerPid, startTime: claim.ownerStartTime },
        { pid: retained.ownership.ownerPid, startTime: retained.ownership.ownerStartTime },
      ) ||
      claim.recordingFence?.token !== retained.fence.token ||
      claim.recordingFence.generation !== retained.fence.generation ||
      !claim.recordingRuntimeOwner ||
      !sameRuntimeOwner(claim.recordingRuntimeOwner, retained.owner)
    )
      throw claimError();
    const before = screenRecordingDurableResource.store.read(params.resourcePath);
    if (
      retained.purpose === 'start' &&
      before.status !== 'unreattachable' &&
      (before.status === 'missing' ||
        before.envelope.fence.token !== retained.fence.token ||
        before.envelope.fence.generation !== retained.fence.generation)
    ) {
      try {
        await retained.retry();
      } catch {
        throw cleanupPendingError();
      }
      const after = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env))?.claim;
      if (
        !after ||
        !matchesContext(after, params) ||
        after.ownerToken !== retained.ownership.ownerToken ||
        !after.recordingCleanupPending ||
        after.recordingFence?.token !== retained.fence.token ||
        after.recordingFence.generation !== retained.fence.generation ||
        !after.recordingRuntimeOwner ||
        !sameRuntimeOwner(after.recordingRuntimeOwner, retained.owner) ||
        !ownerIdentityMatches(
          { pid: after.ownerPid, startTime: after.ownerStartTime },
          { pid: retained.ownership.ownerPid, startTime: retained.ownership.ownerStartTime },
        )
      )
        throw claimError();
      if (retained.startProof) {
        const released = await finishRecordingClaimUnderLock(
          {
            ...params,
            ownership: retained.ownership,
            action: 'start',
            succeeded: false,
            runtimeDisposed: true,
            startAttempted: true,
            startProof: retained.startProof,
            startFence: retained.fence,
            expectedOwner: retained.owner,
            releaseWhenComplete: retained.releaseWhenComplete,
            retainForSession: false,
          },
          key,
        );
        return released ? 'released' : 'settled';
      }
      const { recordingCleanupPending: _, ...settled } = after;
      writeDeviceClaim(settled, params.env);
      return 'settled';
    }
    const settle = async (
      envelope: DurableResourceEnvelope<'screen-recording'>,
      completed: boolean,
      markRolledBack?: () => void,
    ) => {
      if (
        envelope.sessionId !== claim.session ||
        !sameDeviceIdentity(envelope.device, claim.device) ||
        !sameRuntimeOwner(envelope.owner, retained.owner) ||
        envelope.metadata?.[CLAIM_TOKEN] !== claim.ownerToken
      )
        throw claimError();
      try {
        await retained.retry();
      } catch {
        throw cleanupPendingError();
      }
      const after = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env))?.claim;
      const manifest = screenRecordingDurableResource.store.read(params.resourcePath);
      if (
        !after ||
        !matchesContext(after, params) ||
        after.ownerToken !== claim.ownerToken ||
        !after.recordingCleanupPending ||
        after.recordingFence?.token !== retained.fence.token ||
        after.recordingFence.generation !== retained.fence.generation ||
        !after.recordingRuntimeOwner ||
        !sameRuntimeOwner(after.recordingRuntimeOwner, retained.owner) ||
        !ownerIdentityMatches(
          { pid: after.ownerPid, startTime: after.ownerStartTime },
          { pid: claim.ownerPid, startTime: claim.ownerStartTime },
        ) ||
        manifest.status !== 'decoded' ||
        manifest.envelope.fence.token !== retained.fence.token ||
        manifest.envelope.fence.generation !== retained.fence.generation ||
        manifest.envelope.lifecycle !== (completed ? 'completed' : 'open') ||
        manifest.envelope.sessionId !== claim.session ||
        !sameDeviceIdentity(manifest.envelope.device, claim.device) ||
        manifest.envelope.metadata?.[CLAIM_TOKEN] !== claim.ownerToken ||
        !sameRuntimeOwner(manifest.envelope.owner, retained.owner)
      )
        throw claimError();
      if (retained.purpose === 'start' && retained.startProof && !completed) {
        if (!markRolledBack) throw cleanupPendingError();
        markRolledBack();
        completed = true;
      }
      if (retained.purpose === 'close' && completed && retained.releaseWhenComplete) {
        fs.unlinkSync(resolveDeviceClaimPath(key, params.env));
        return 'released' as const;
      }
      if (
        completed &&
        claim.claimOwnerKind === 'transient-command' &&
        claim.transientCommand === 'record' &&
        params.retainForSession?.(retained.ownership)
      ) {
        const { recordingCleanupPending: _, transientCommand: _command, ...rest } = after;
        writeDeviceClaim({ ...rest, claimOwnerKind: 'open-session' }, params.env);
        return 'settled' as const;
      }
      if (
        completed &&
        claim.claimOwnerKind === 'transient-command' &&
        claim.transientCommand === 'record'
      ) {
        fs.unlinkSync(resolveDeviceClaimPath(key, params.env));
        return 'released' as const;
      }
      const { recordingCleanupPending: _, ...settled } = after;
      writeDeviceClaim(settled, params.env);
      return 'settled' as const;
    };
    return await withDurableCaptureResourceFence({
      store: screenRecordingDurableResource.store,
      resourcePath: params.resourcePath,
      expected: retained.fence,
      onCompleted: async ({ envelope }) => await settle(envelope, true),
      run: async (lease) =>
        await settle(lease.envelope, false, () => {
          lease.transition('completed', {
            metadata: { ...lease.envelope.metadata, phase: 'completed', cleanupStatus: 'cleaned' },
          });
        }),
    });
  });
}

function cleanupPendingError(): AppError {
  return new AppError('COMMAND_FAILED', 'Recording runtime cleanup is not confirmed', {
    reason: 'cleanup-unconfirmed',
    retriable: true,
  });
}

/** Explicit same-session recovery of an incomplete start; platform evidence supplies the proof. */
export async function recoverIncompleteRecordingStartClaim(
  params: RecordingClaimContext & {
    gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
    scope: PlatformRequestScope;
    retainFailedCleanup?: (cleanup: RetainedRecordingCleanup) => void;
  },
): Promise<boolean> {
  return await withRecordingClaimLocks(params, async (key) => {
    const claim = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env))?.claim;
    if (!claim || !matchesContext(claim, params)) return false;
    if (claim.recordingCleanupPending) throw cleanupPendingError();
    if (!isIncompleteRecordingStartClaim(claim)) return false;
    const current = readCurrentOwnerIdentity();
    if (!ownerIdentityMatches({ pid: claim.ownerPid, startTime: claim.ownerStartTime }, current)) {
      const liveness = classifyOwnerLiveness({
        owner: { pid: claim.ownerPid, startTime: claim.ownerStartTime },
      });
      if (liveness !== 'owner-process-dead' && liveness !== 'owner-process-reused')
        throw claimError();
    }
    if (!beginIncompleteStartRecoveryCleanup(claim, params.env)) throw claimError();
    const recovered = await recoverIncompleteRecordingClaim(
      claim,
      params.gateway,
      params.scope,
      (retry) => {
        if (
          ownerIdentityMatches({ pid: claim.ownerPid, startTime: claim.ownerStartTime }, current) &&
          claim.recordingFence &&
          claim.recordingRuntimeOwner
        )
          params.retainFailedCleanup?.({
            device: params.device,
            owner: claim.recordingRuntimeOwner,
            fence: claim.recordingFence,
            ownership: ownershipFromClaim(claim),
            purpose: 'start',
            releaseWhenComplete: claim.claimOwnerKind === 'transient-command',
            retry,
          });
      },
    );
    if (recovered === 'cleanup-unconfirmed') throw cleanupPendingError();
    if (!finishIncompleteStartRecoveryCleanup(claim, params.env)) throw claimError();
    if (recovered !== 'confirmed-no-effect') throw cleanupPendingError();
    const after = inspectDeviceClaimFile(resolveDeviceClaimPath(key, params.env))?.claim;
    if (
      !after ||
      !matchesContext(after, params) ||
      after.ownerToken !== claim.ownerToken ||
      after.recordingCleanupPending ||
      after.recordingFence?.token !== claim.recordingFence?.token ||
      after.recordingFence?.generation !== claim.recordingFence?.generation ||
      !ownerIdentityMatches(
        { pid: after.ownerPid, startTime: after.ownerStartTime },
        { pid: claim.ownerPid, startTime: claim.ownerStartTime },
      )
    )
      throw claimError();
    if (!isIncompleteRecordingStartClaim(after)) throw claimError();
    if (after.claimOwnerKind === 'open-session') {
      const { recordingStartPending: _, ...settled } = after;
      writeDeviceClaim(settled, params.env);
      return true;
    }
    fs.unlinkSync(resolveDeviceClaimPath(key, params.env));
    return true;
  });
}
