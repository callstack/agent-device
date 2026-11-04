import path from 'node:path';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type {
  OwnedProcessRecord,
  OwnedProcessRecordScope,
} from '@agent-device/contracts/platform-runtime-host';
import { sameRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { withDurableCaptureResourceFence } from '@agent-device/capture-kit/durable-capture';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY } from '@agent-device/capture-kit/screen-recording-resource-store';
import {
  classifyOwnerLiveness,
  readHostProcessIdentityObservations,
  readCurrentOwnerIdentity,
} from '@agent-device/host-kit/process';
import { isSafeSessionSegment } from '@agent-device/host-kit/session-paths';
import { tryAcquireProcessLock } from '@agent-device/host-kit/file';
import { hostDeviceIdOf, sameDeviceIdentity } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { inspectDeviceClaimFile } from './device-claim-inspection.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from './device-claim-paths.ts';
import type { DeviceClaim } from './device-claim-record.ts';
import { resolveSessionDir } from './session-artifact-paths.ts';

const RECORDING_REAP_ADMISSION_BUDGET_MS = 1_000;

export type RecordingReapRetention = Readonly<{
  reason:
    | 'claim-lock-busy'
    | 'claim-lock-unproven'
    | 'admission-budget-exhausted'
    | 'recording-cleanup-pending';
  sessionId: string;
  pid: number;
  resourcePath: string;
}>;

/** Run a simulator ledger reaper only while its exact dead owner's claim and recording are guarded. */
export function createRecordingReapAdmission(params: {
  stateDir: string;
  sessionsDir: string;
  env: EnvMap;
  onRetained: (retention: RecordingReapRetention) => void;
}) {
  const deadline = performance.now() + RECORDING_REAP_ADMISSION_BUDGET_MS;
  return async (
    scope: OwnedProcessRecordScope,
    process: OwnedProcessRecord,
    reap: () => Promise<void>,
  ): Promise<void> => {
    if (
      scope.kind !== 'session' ||
      process.purpose !== 'simctl-screen-recording' ||
      !isSafeSessionSegment(scope.sessionId)
    )
      return;
    const store = screenRecordingDurableResource.store;
    const resourcePath = store.resolvePath(resolveSessionDir(params.sessionsDir, scope.sessionId));
    const retain = (reason: RecordingReapRetention['reason']) =>
      params.onRetained({ reason, sessionId: scope.sessionId, pid: process.pid, resourcePath });
    if (performance.now() >= deadline) {
      retain('admission-budget-exhausted');
      return;
    }
    const initial = store.read(resourcePath);
    if (initial.status !== 'decoded' || !matchesProcess(initial.envelope, process)) return;
    const expected = initial.envelope;
    if (
      !isSafeSessionSegment(expected.sessionId) ||
      resolveSessionDir(params.sessionsDir, expected.sessionId) !== path.dirname(resourcePath)
    )
      return;
    const key = canonicalLocalDeviceKey(expected.device);
    const claimPath = resolveDeviceClaimPath(key, params.env);
    const scanned = inspectDeviceClaimFile(claimPath)?.claim;
    if (!scanned || !matchesClaim(scanned, expected, params.stateDir)) return;
    if (scanned.recordingCleanupPending) {
      retain('recording-cleanup-pending');
      return;
    }
    const hostId = hostDeviceIdOf(expected.device.id);
    const hostKey =
      hostId === expected.device.id
        ? undefined
        : canonicalLocalDeviceKey({ ...expected.device, id: hostId });
    const tryClaimLock = (deviceKey: string) => {
      const owner = readCurrentOwnerIdentity();
      return tryAcquireProcessLock({
        lockDirPath: `${resolveDeviceClaimPath(deviceKey, params.env)}.lock`,
        owner: { ...owner, acquiredAtMs: Date.now() },
        description: `device claim for ${deviceKey}`,
      });
    };
    if (performance.now() >= deadline) {
      retain('admission-budget-exhausted');
      return;
    }
    const hostAttempt = hostKey === undefined ? undefined : tryClaimLock(hostKey);
    if (hostAttempt && hostAttempt.status !== 'acquired') {
      retain(hostAttempt.status === 'busy' ? 'claim-lock-busy' : 'claim-lock-unproven');
      return;
    }
    const hostLock = hostAttempt?.acquisition;
    try {
      if (hostKey && inspectDeviceClaimFile(resolveDeviceClaimPath(hostKey, params.env))) return;
      if (performance.now() >= deadline) {
        retain('admission-budget-exhausted');
        return;
      }
      const attempt = tryClaimLock(key);
      if (attempt.status !== 'acquired') {
        retain(attempt.status === 'busy' ? 'claim-lock-busy' : 'claim-lock-unproven');
        return;
      }
      const lock = attempt.acquisition;
      try {
        if (performance.now() >= deadline) {
          retain('admission-budget-exhausted');
          return;
        }
        const current = inspectDeviceClaimFile(claimPath)?.claim;
        if (current?.recordingCleanupPending) {
          retain('recording-cleanup-pending');
          return;
        }
        if (
          !current ||
          !sameClaim(scanned, current) ||
          !matchesClaim(current, expected, params.stateDir)
        )
          return;
        if (!oldOwnerIsGone(current)) return;
        try {
          await withDurableCaptureResourceFence({
            store,
            resourcePath,
            expected: expected.fence,
            onCompleted: () => {},
            run: async ({ envelope }) => {
              hostLock?.assertHeld();
              lock.assertHeld();
              if (performance.now() >= deadline) {
                retain('admission-budget-exhausted');
                return;
              }
              if (
                envelope.sessionId !== expected.sessionId ||
                !sameDeviceIdentity(envelope.device, expected.device) ||
                !sameRuntimeOwner(envelope.owner, expected.owner) ||
                !matchesClaim(current, envelope, params.stateDir) ||
                !matchesProcess(envelope, process)
              )
                return;
              await reap();
            },
          });
        } catch (error) {
          if (!(error instanceof AppError && error.details?.reason === 'ownership-fence-lost'))
            throw error;
        }
      } finally {
        await lock.release();
      }
    } finally {
      await hostLock?.release();
    }
  };
}

type RecordingEnvelope = DurableResourceEnvelope<'screen-recording'>;

function matchesClaim(claim: DeviceClaim, envelope: RecordingEnvelope, stateDir: string): boolean {
  if (
    path.resolve(claim.stateDir) !== path.resolve(stateDir) ||
    claim.session !== envelope.sessionId ||
    !sameDeviceIdentity(claim.device, envelope.device) ||
    !claim.recordingRuntimeOwner ||
    !sameRuntimeOwner(claim.recordingRuntimeOwner, envelope.owner) ||
    envelope.metadata?.[SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY] !== claim.ownerToken
  )
    return false;
  return (
    (claim.claimOwnerKind === 'open-session' ||
      (claim.claimOwnerKind === 'transient-command' && claim.transientCommand === 'record')) &&
    claim.recordingFence?.token === envelope.fence.token &&
    claim.recordingFence.generation === envelope.fence.generation
  );
}

function sameClaim(left: DeviceClaim, right: DeviceClaim): boolean {
  return (
    left.deviceKey === right.deviceKey &&
    sameDeviceIdentity(left.device, right.device) &&
    left.session === right.session &&
    path.resolve(left.stateDir) === path.resolve(right.stateDir) &&
    path.resolve(left.workspace) === path.resolve(right.workspace) &&
    left.ownerPid === right.ownerPid &&
    left.ownerStartTime === right.ownerStartTime &&
    left.ownerToken === right.ownerToken &&
    left.claimOwnerKind === right.claimOwnerKind &&
    left.transientCommand === right.transientCommand &&
    left.recordingFence?.token === right.recordingFence?.token &&
    left.recordingFence?.generation === right.recordingFence?.generation &&
    left.abandonedAtMs === right.abandonedAtMs
  );
}

function matchesProcess(envelope: RecordingEnvelope, process: OwnedProcessRecord): boolean {
  const descriptor = envelope.descriptor;
  const body = descriptor.body;
  return (
    envelope.lifecycle === 'open' &&
    envelope.device.family === 'apple' &&
    envelope.device.kind === 'simulator' &&
    envelope.owner.kind === 'local-family' &&
    envelope.owner.family === 'apple' &&
    descriptor.version === 1 &&
    body.backend === 'simctl' &&
    Array.isArray(body.processes) &&
    body.processes.some(
      (item) =>
        isRecord(item) &&
        item.pid === process.pid &&
        item.startTime === process.startTime &&
        item.command === process.command,
    )
  );
}

function oldOwnerIsGone(claim: DeviceClaim): boolean {
  const owner = { pid: claim.ownerPid, startTime: claim.ownerStartTime };
  const liveness = classifyOwnerLiveness({ owner });
  if (liveness === 'owner-process-reused') return true;
  if (liveness !== 'owner-process-dead') return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const observation = readHostProcessIdentityObservations([owner.pid]).get(owner.pid);
  return observation?.state.startsWith('Z') ?? false;
}
