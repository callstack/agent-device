import path from 'node:path';
import type { DeviceRuntimeGateway } from '@agent-device/contracts/platform-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { sameDeviceIdentity } from '@agent-device/kernel/device';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { resolveDaemonPaths } from './config.ts';
import { appLogDurableResource } from './app-log-session-resource.ts';
import { recoverAppLogResourceAfterDaemonLock } from './app-log-resource-recovery.ts';
import type { DeviceClaim } from './device-claim-record.ts';
import type { DeviceClaimReconciler } from './device-claims.ts';
import type { DurableCaptureRecoveryOutcome } from './durable-capture-resource-recovery.ts';
import type { DurableSessionResourceKind } from './durable-session-resource-kinds.ts';
import { safeSessionName } from './session-paths.ts';
import { screenRecordingDurableResource } from './screen-recording-session-resource.ts';
import { recoverScreenRecordingResourceAfterDaemonLock } from './screen-recording-resource-recovery.ts';
import { audioProbeDurableResource } from './audio-probe-session-resource.ts';
import { recoverAudioProbeResourceAfterDaemonLock } from './audio-probe-resource-recovery.ts';
import { perfCaptureDurableResource } from './perf-capture-session-resource.ts';
import { recoverPerfCaptureResourceAfterDaemonLock } from './perf-capture-resource-recovery.ts';

export function createDeviceClaimReconciler(params: {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
}): DeviceClaimReconciler {
  return async (claim) => {
    const sessionsDir = resolveDaemonPaths(claim.stateDir).sessionsDir;
    const sessionDir = path.join(sessionsDir, safeSessionName(claim.session));
    try {
      for (const resource of Object.values(DEVICE_CLAIM_DURABLE_RESOURCES)) {
        const ownership = inspectResourceOwnership(resource, claim, sessionDir);
        if (ownership.status === 'retained') {
          return { status: 'retained', reason: ownership.reason };
        }
        // Recovery is intentionally sequential: both resources can bind the same exact
        // device/runtime owner, so one must release its binding before the next starts.
        if (ownership.status === 'owned') {
          const outcome = await resource.recover(params, sessionsDir, ownership.resourcePath);
          if (outcome === 'retained') {
            return {
              status: 'retained',
              reason: `${resource.resourceKind}-cleanup-pending`,
            };
          }
        }
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
  | { status: 'owned'; resourcePath: string }
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
  return { status: 'owned', resourcePath };
}
