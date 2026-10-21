import { appLogDurableResource } from '@agent-device/capture-kit/app-log-durable-resource';
import { recoverAppLogResourceAfterDaemonLock } from '@agent-device/capture-kit/app-log-resource-recovery';
import path from 'node:path';
import type { DeviceRuntimeGateway } from '@agent-device/contracts/platform-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { sameDeviceIdentity } from '@agent-device/kernel/device';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { resolveDaemonPaths } from './daemon-resolution.ts';
import type { DeviceClaim, DeviceClaimReconciler } from './device-claims.ts';
import type { DurableCaptureRecoveryOutcome } from '@agent-device/capture-kit/durable-capture';
import { recoverAudioProbeResourceAfterDaemonLock } from '@agent-device/capture-kit/audio-probe-recovery';
import { audioProbeDurableResource } from '@agent-device/capture-kit/audio-probe-session-resource';
import { type DurableSessionResourceKind } from '@agent-device/capture-kit/durable-capture-resource';
import { recoverPerfCaptureResourceAfterDaemonLock } from '@agent-device/capture-kit/perf-capture-recovery';
import { perfCaptureDurableResource } from '@agent-device/capture-kit/perf-capture-session-resource';
import { recoverScreenRecordingResourceAfterDaemonLock } from '@agent-device/capture-kit/screen-recording-recovery';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { safeSessionName } from '@agent-device/host-kit/session-paths';

export function createDeviceClaimReconciler(params: {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
}): (
  claim: DeviceClaim,
  inspection?: ClaimRecoveryInspection,
) => ReturnType<DeviceClaimReconciler> {
  return async (claim, suppliedInspection) => {
    const inspection = suppliedInspection ?? inspectDeviceClaimRecovery(claim);
    if (inspection.status === 'retained') return inspection;
    try {
      const sessionsDir = resolveDaemonPaths(claim.stateDir).sessionsDir;
      const sessionDir = path.join(sessionsDir, safeSessionName(claim.session));
      for (const { resourceKind, resourcePath } of inspection.ownedResources) {
        const resource = DEVICE_CLAIM_DURABLE_RESOURCES[resourceKind];
        const currentOwnership = inspectResourceOwnership(resource, claim, sessionDir);
        if (currentOwnership.status === 'retained') return currentOwnership;
        if (currentOwnership.status === 'missing') continue;
        // Recovery is intentionally sequential: resources can bind the same exact
        // device/runtime owner, so one must release its binding before the next starts.
        const outcome = await resource.recover(params, sessionsDir, resourcePath);
        if (outcome === 'retained') {
          return {
            status: 'retained',
            reason: `${resource.resourceKind}-cleanup-pending`,
          };
        }
      }
      const afterRecovery = inspectDeviceClaimRecovery(claim);
      if (afterRecovery.status === 'retained') return afterRecovery;
      const initialPaths = new Set(
        inspection.ownedResources.map(({ resourcePath }) => resourcePath),
      );
      const pending = afterRecovery.ownedResources.find(
        ({ resourceKind, resourcePath }) =>
          !initialPaths.has(resourcePath) || afterRecovery.recoveryKinds.includes(resourceKind),
      );
      if (pending) {
        return { status: 'retained', reason: `${pending.resourceKind}-cleanup-pending` };
      }
      return { status: 'reconciled' };
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'device_claim_orphan_reconciliation_failed',
        data: {
          deviceKey: claim.deviceKey,
          ownerSession: claim.session,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return { status: 'retained', reason: 'durable-resource-reconciliation-failed' };
    }
  };
}

export type ClaimRecoveryInspection =
  | {
      status: 'inspectable';
      recoveryKinds: readonly DurableSessionResourceKind[];
      ownedResources: readonly Readonly<{
        resourceKind: DurableSessionResourceKind;
        resourcePath: string;
      }>[];
    }
  | { status: 'retained'; reason: string };

/** Inspect exact-owner durable manifests without composing a gateway or settling a resource. */
export function inspectDeviceClaimRecovery(claim: DeviceClaim): ClaimRecoveryInspection {
  try {
    const sessionsDir = resolveDaemonPaths(claim.stateDir).sessionsDir;
    const sessionDir = path.join(sessionsDir, safeSessionName(claim.session));
    const recoveryKinds: DurableSessionResourceKind[] = [];
    const ownedResources: { resourceKind: DurableSessionResourceKind; resourcePath: string }[] = [];
    for (const resource of Object.values(DEVICE_CLAIM_DURABLE_RESOURCES)) {
      const ownership = inspectResourceOwnership(resource, claim, sessionDir);
      if (ownership.status === 'retained') return ownership;
      if (ownership.status === 'owned') {
        ownedResources.push({
          resourceKind: resource.resourceKind,
          resourcePath: ownership.resourcePath,
        });
        if (ownership.requiresRecovery) recoveryKinds.push(resource.resourceKind);
      }
    }
    return { status: 'inspectable', recoveryKinds, ownedResources };
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'device_claim_orphan_reconciliation_failed',
      data: {
        deviceKey: claim.deviceKey,
        ownerSession: claim.session,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return { status: 'retained', reason: 'durable-resource-reconciliation-failed' };
  }
}

type ClaimDurableResource = Readonly<{
  resourceKind: DurableSessionResourceKind;
  store:
    | typeof appLogDurableResource.store
    | typeof screenRecordingDurableResource.store
    | typeof audioProbeDurableResource.store
    | typeof perfCaptureDurableResource.store;
  recover(
    params: Parameters<typeof createDeviceClaimReconciler>[0],
    sessionsDir: string,
    resourcePath: string,
  ): Promise<DurableCaptureRecoveryOutcome>;
}>;

const DEVICE_CLAIM_DURABLE_RESOURCES = {
  'app-log': {
    resourceKind: 'app-log',
    store: appLogDurableResource.store,
    recover: async (params, sessionsDir, resourcePath) =>
      await recoverAppLogResourceAfterDaemonLock({
        sessionsDir,
        resourcePath,
        gateway: params.gateway,
        scope: params.scope,
      }),
  },
  'screen-recording': {
    resourceKind: 'screen-recording',
    store: screenRecordingDurableResource.store,
    recover: async (params, sessionsDir, resourcePath) =>
      await recoverScreenRecordingResourceAfterDaemonLock({
        sessionsDir,
        resourcePath,
        gateway: params.gateway,
        scope: params.scope,
      }),
  },
  'audio-probe': {
    resourceKind: 'audio-probe',
    store: audioProbeDurableResource.store,
    recover: async (params, sessionsDir, resourcePath) =>
      await recoverAudioProbeResourceAfterDaemonLock({
        sessionsDir,
        resourcePath,
        gateway: params.gateway,
        scope: params.scope,
      }),
  },
  'perf-capture': {
    resourceKind: 'perf-capture',
    store: perfCaptureDurableResource.store,
    recover: async (params, sessionsDir, resourcePath) =>
      await recoverPerfCaptureResourceAfterDaemonLock({
        sessionsDir,
        resourcePath,
        gateway: params.gateway,
        scope: params.scope,
      }),
  },
} satisfies Record<DurableSessionResourceKind, ClaimDurableResource>;

function inspectResourceOwnership(
  resource: ClaimDurableResource,
  claim: DeviceClaim,
  sessionDir: string,
):
  | { status: 'missing' }
  | { status: 'owned'; resourcePath: string; requiresRecovery: boolean }
  | { status: 'retained'; reason: string } {
  const resourcePath = resource.store.resolvePath(sessionDir);
  const record = resource.store.read(resourcePath);
  if (record.status === 'missing') return { status: 'missing' };
  if (record.status === 'unreattachable') {
    return {
      status: 'retained',
      reason: `${resource.resourceKind}-${record.reason}`,
    };
  }
  if (
    record.envelope.sessionId !== claim.session ||
    !sameDeviceIdentity(record.envelope.device, claim.device)
  ) {
    return { status: 'retained', reason: `${resource.resourceKind}-owner-mismatch` };
  }
  return { status: 'owned', resourcePath, requiresRecovery: record.envelope.lifecycle === 'open' };
}
