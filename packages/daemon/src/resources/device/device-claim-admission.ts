import { deviceIdentity, sameDeviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  sameRuntimeOwner,
  type DeviceRuntimeGateway,
  type RuntimeOwnerRef,
  type ResourceOwnershipFence,
} from '@agent-device/contracts/platform-runtime';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import path from 'node:path';
import type { DeviceClaimPolicy } from '@agent-device/command-registry/types';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { deviceClaimConflictError } from './device-claim-conflict.ts';
import { deviceClaimRuleForOwner } from './device-claim-rule.ts';
import {
  abandonDeviceClaim,
  acquireTransientDeviceClaim,
  admitRecordingStop,
  finishRecordingClaimRequest,
  reserveRecordingClaimFence,
  retryRecordingClaimCleanup,
  recoverIncompleteRecordingStartClaim,
  findIncompleteRecordingReservation,
  type RetainedRecordingCleanup,
  clearDeviceClaim,
  type DeviceClaimReconciler,
  type DeviceClaimSessionOwnership,
} from '@agent-device/daemon-contracts/device-claims';

/**
 * The #1320 claim gate a request passes on its way from a device binding to
 * device operations. The device-claim rule of the admitted owner decides what
 * happens here, under every policy: an ordinary owner takes a transient claim
 * only when the executing command's declared {@link DeviceClaimPolicy} is
 * `transient-exclusive`; a provider owner takes nothing.
 *
 * `admit` is called once per device binding by the request runtime bindings,
 * which is where per-device deduplication already lives. A command handler has no other way to obtain
 * device operations, so a handler cannot forget any of this. Two daemon-owned
 * recovery paths do bind outside the seam and are the known gap:
 * application-lifecycle-recovery.ts (ordinary intent, daemon shutdown) and
 * durable-capture-runtime-recovery.ts (exact-owner intent read back from a
 * durable envelope).
 */
export type DeviceClaimAdmission = AsyncDisposable &
  Readonly<{
    /** Throws `DEVICE_IN_USE` when a foreign live claim owns the device. */
    admit(device: DeviceInfo, owner: RuntimeOwnerRef): Promise<void>;
    recordingSucceeded(): void;
    recordingStartAttempt(): void;
    recordingStartNoEffect(proof: 'not-dispatched' | 'rolled-back'): void;
    recordingClaimOwnership(): DeviceClaimSessionOwnership | undefined;
    reserveRecordingFence(fence: ResourceOwnershipFence): Promise<void>;
    runtimeDisposalFailed(): void;
    recoverIncompleteStart(device: DeviceInfo): Promise<boolean>;
    incompleteStartDevice(): ReturnType<typeof findIncompleteRecordingReservation>;
    retainedRecordingCleanup(retry: () => Promise<void>): RetainedRecordingCleanup | undefined;
    retryRecordingCleanup(
      device: DeviceInfo,
      retained?: RetainedRecordingCleanup,
    ): Promise<'none' | 'settled' | 'released'>;
  }>;

export function createDeviceClaimAdmission(params: {
  policy: DeviceClaimPolicy;
  recordingAction?: 'start' | 'stop';
  recordingClaimReleased?: (ownership: DeviceClaimSessionOwnership) => void;
  currentSessionClaim?: () => DeviceClaimSessionOwnership | undefined;
  retainFailedRecordingCleanup?: (cleanup: RetainedRecordingCleanup) => void;
  recordingHasOtherOwners?: (ownership: DeviceClaimSessionOwnership) => boolean;
  command: string;
  /**
   * The session this request runs in, which is the only session whose own claim
   * covers a `transient-exclusive` command. Sessions of one daemon are separate
   * device owners (#3345), so the request's routed session address — not the
   * daemon's process identity — is what admission compares a held claim against.
   * Addresses are copyable, so session equality alone is not ownership: the
   * covered claim must also record this request's workspace.
   */
  session: string;
  workspace: string;
  /**
   * The caller's raw cwd when the request carried one, or nothing for a caller without a
   * workspace of its own (SDK requests). The covered-claim check compares workspaces;
   * {@link workspace} cannot serve it because its daemon-directory fallback would refuse
   * exactly the SDK requests whose own session claims should cover them.
   */
  callerCwd: string | undefined;
  /**
   * Canonicalizes a workspace to the root session routing hashes into a session address.
   * The claim layer cannot reach routing itself, so the composition root hands over the same
   * function routing uses: comparing raw directories would separate a caller that ran `open`
   * at the checkout root from its own claim recorded against that root.
   */
  resolveScopeRoot: (workspace: string | undefined) => string | undefined;
  stateDir: string;
  env: EnvMap;
  gateway?: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope?: PlatformRequestScope;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): DeviceClaimAdmission {
  // The caller admits once per device binding, so this only has to remember what
  // it took in order to give it back.
  const acquired: DeviceClaimSessionOwnership[] = [];
  let recordingSucceeded = false;
  let startAttempted = false;
  let startProof: 'not-dispatched' | 'rolled-back' | undefined;
  let startFence: ResourceOwnershipFence | undefined;
  let runtimeDisposed = true;
  let recording:
    | {
        device: DeviceInfo;
        owner: RuntimeOwnerRef;
        ownership?: DeviceClaimSessionOwnership;
        coveredOwnership?: DeviceClaimSessionOwnership;
        stopLease?: Awaited<ReturnType<typeof admitRecordingStop>>;
      }
    | undefined;
  const recordingResourcePath = screenRecordingDurableResource.store.resolvePath(
    path.join(resolveDaemonPaths(params.stateDir).sessionsDir, safeSessionName(params.session)),
  );
  const requestScopeRoot = params.resolveScopeRoot(params.callerCwd);
  const recordingContext = (device: DeviceInfo) => ({
    device,
    session: params.session,
    workspace: params.workspace,
    stateDir: params.stateDir,
    resourcePath: recordingResourcePath,
    workspaceMatches: (workspace: string) =>
      !requestScopeRoot || params.resolveScopeRoot(workspace) === requestScopeRoot,
    env: params.env,
  });

  /**
   * Only `transient-exclusive` writes the claim store here: `observe`/`require-owner` never do,
   * and `acquire-session`/`release-session` own the session claim through the open and close
   * lifecycles instead.
   */
  async function admitOrdinaryOwner(device: DeviceInfo): Promise<void> {
    if (params.policy !== 'transient-exclusive' && params.recordingAction !== 'start') return;
    const result = await acquireTransientDeviceClaim({
      device,
      command: params.command,
      ...(params.recordingAction === 'start'
        ? { recordingSession: params.session, refuseForeignClaim: true }
        : {}),
      coveredBySession: params.session,
      coveredRecordingOwnership: params.currentSessionClaim?.(),
      coveredClaimIsOwnedByRequest: (claim) =>
        !requestScopeRoot || params.resolveScopeRoot(claim.workspace) === requestScopeRoot,
      workspace: params.workspace,
      stateDir: params.stateDir,
      env: params.env,
      reconcileOrphanedDeviceClaim: params.reconcileOrphanedDeviceClaim,
    });
    if (result.status === 'acquired') {
      if (params.recordingAction === 'start') {
        recording!.ownership = result.ownership;
      } else {
        acquired.push(result.ownership);
      }
      return;
    }
    if (result.status === 'covered-by-owned-claim' && params.recordingAction === 'start') {
      recording!.coveredOwnership = result.ownership;
      return;
    }
    if (result.status === 'conflict') {
      // A command-scoped claim this request took for this device covers a re-bind of
      // it; the same claim seen by any other request is a live owner.
      const held = result.conflict.claim;
      if (held && acquired.some((ownership) => ownership.ownerToken === held.ownerToken)) return;
      throw deviceClaimConflictError(device, result.conflict);
    }
  }

  return {
    admit: async (device, owner) => {
      switch (deviceClaimRuleForOwner(owner)) {
        case 'none':
          return;
        case 'ordinary': {
          if (params.recordingAction) {
            if (recording) {
              if (
                !sameRuntimeOwner(recording.owner, owner) ||
                !sameDeviceIdentity(deviceIdentity(recording.device), deviceIdentity(device))
              )
                throw new Error('Recording runtime owner changed during request');
              recording.stopLease?.assertCurrent();
              return;
            }
            recording = { device, owner };
            if (params.recordingAction === 'stop') {
              const result = await admitRecordingStop({
                ...recordingContext(device),
                owner,
                sessionOwnership: params.currentSessionClaim?.(),
              });
              recording.stopLease = result;
              if (result.status === 'reserved') recording.ownership = result.ownership;
              return;
            }
          }
          return await admitOrdinaryOwner(device);
        }
      }
    },
    recordingSucceeded: () => {
      recordingSucceeded = true;
    },
    recordingStartAttempt: () => {
      startAttempted = true;
    },
    recordingStartNoEffect: (proof) => {
      startProof = proof;
    },
    recordingClaimOwnership: () => recording?.ownership ?? recording?.coveredOwnership,
    reserveRecordingFence: async (fence) => {
      const ownership = recording?.ownership ?? recording?.coveredOwnership;
      if (recording && ownership) {
        await reserveRecordingClaimFence({
          ...recordingContext(recording.device),
          ownership,
          fence,
          owner: recording.owner,
        });
        startFence = fence;
      }
    },
    retainedRecordingCleanup: (retry) => {
      if (recording?.stopLease)
        return {
          device: recording.device,
          owner: recording.stopLease.owner,
          fence: recording.stopLease.fence,
          ownership: recording.stopLease.ownership,
          purpose: 'stop',
          retry,
        };
      const ownership = recording?.ownership ?? recording?.coveredOwnership;
      if (recording && ownership && startFence)
        return {
          device: recording.device,
          owner: recording.owner,
          fence: startFence,
          ownership,
          purpose: 'start',
          startProof,
          releaseWhenComplete: recording.ownership !== undefined,
          retry,
        };
      return undefined;
    },
    retryRecordingCleanup: async (device, retained) =>
      await retryRecordingClaimCleanup({
        ...recordingContext(device),
        retained,
        retainForSession: params.recordingHasOtherOwners,
      }),
    recoverIncompleteStart: async (device) => {
      if (!params.gateway || !params.scope) return false;
      return await recoverIncompleteRecordingStartClaim({
        ...recordingContext(device),
        gateway: params.gateway,
        scope: params.scope,
        retainFailedCleanup: params.retainFailedRecordingCleanup,
      });
    },
    incompleteStartDevice: () =>
      findIncompleteRecordingReservation({
        session: params.session,
        stateDir: params.stateDir,
        workspaceMatches: (workspace) =>
          !requestScopeRoot || params.resolveScopeRoot(workspace) === requestScopeRoot,
        env: params.env,
      }),
    runtimeDisposalFailed: () => {
      runtimeDisposed = false;
    },
    [Symbol.asyncDispose]: async () => {
      if (recording?.stopLease) {
        const released = await recording.stopLease.finish({
          action: 'stop',
          succeeded: recordingSucceeded,
          runtimeDisposed,
          startAttempted,
          retainForSession: params.recordingHasOtherOwners?.(recording.stopLease.ownership),
        });
        if (released && recording.ownership) params.recordingClaimReleased?.(recording.ownership);
      } else if (
        recording &&
        (recording.ownership || recording.coveredOwnership) &&
        params.recordingAction === 'start'
      ) {
        const ownership = recording.ownership ?? recording.coveredOwnership!;
        const released = await finishRecordingClaimRequest({
          ...recordingContext(recording.device),
          ownership,
          action: 'start',
          succeeded: recordingSucceeded,
          runtimeDisposed,
          startAttempted,
          startProof,
          startFence,
          expectedOwner: recording.owner,
          releaseWhenComplete: recording.ownership !== undefined,
        });
        if (released) params.recordingClaimReleased?.(ownership);
      }
      for (const ownership of acquired.splice(0)) {
        try {
          await clearDeviceClaim(ownership, params.env);
        } catch (error) {
          emitDiagnostic({
            level: 'error',
            phase: 'transient_device_claim_release_failed',
            data: {
              command: params.command,
              deviceKey: ownership.deviceKey,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          // A live record whose unlink failed would refuse this session's own next
          // command, so it must not stay live: abandoned means "holds it for nobody",
          // which the next acquire supersedes.
          try {
            await abandonDeviceClaim(ownership, params.env);
          } catch (abandonError) {
            emitDiagnostic({
              level: 'error',
              phase: 'transient_device_claim_abandon_failed',
              data: {
                command: params.command,
                deviceKey: ownership.deviceKey,
                error: abandonError instanceof Error ? abandonError.message : String(abandonError),
              },
            });
          }
        }
      }
    },
  };
}
