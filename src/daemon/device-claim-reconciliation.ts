import path from 'node:path';
import type {
  DeviceRuntimeGateway,
  DurableResourceEnvelope,
  PlatformRequestScope,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import {
  deviceFieldsFromPublicPlatform,
  deviceIdentity,
  sameDeviceIdentity,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { appLogDurableResource } from './app-log-session-resource.ts';
import { recoverAppLogResourceAfterDaemonLock } from './app-log-resource-recovery.ts';
import type { DeviceClaim, DeviceClaimReconciler } from './device-claims.ts';
import type { DurableCaptureRecoveryOutcome } from './durable-capture-resource-recovery.ts';
import { safeSessionName } from './session-paths.ts';
import { screenRecordingDurableResource } from './screen-recording-session-resource.ts';
import { recoverScreenRecordingResourceAfterDaemonLock } from './screen-recording-resource-recovery.ts';

export function createDeviceClaimReconciler(params: {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
}): DeviceClaimReconciler {
  return async (claim) => {
    const sessionsDir = path.join(claim.stateDir, 'sessions');
    const sessionDir = path.join(sessionsDir, safeSessionName(claim.session));
    try {
      const outcomes = [
        await reconcileAppLog(params, claim, sessionsDir, sessionDir),
        await reconcileScreenRecording(params, claim, sessionsDir, sessionDir),
      ];
      return outcomes.every((outcome) => outcome !== 'retained')
        ? { status: 'reconciled' }
        : { status: 'retained', reason: 'durable-resource-cleanup-pending' };
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

async function reconcileAppLog(
  params: Parameters<typeof createDeviceClaimReconciler>[0],
  claim: DeviceClaim,
  sessionsDir: string,
  sessionDir: string,
): Promise<DurableCaptureRecoveryOutcome> {
  const resourcePath = appLogDurableResource.store.resolvePath(sessionDir);
  if (!resourceBelongsToClaim(appLogDurableResource.store.read(resourcePath), claim)) {
    return 'retained';
  }
  return await recoverAppLogResourceAfterDaemonLock({
    sessionsDir,
    resourcePath,
    gateway: params.gateway,
    scope: params.scope,
  });
}

async function reconcileScreenRecording(
  params: Parameters<typeof createDeviceClaimReconciler>[0],
  claim: DeviceClaim,
  sessionsDir: string,
  sessionDir: string,
): Promise<DurableCaptureRecoveryOutcome> {
  const resourcePath = screenRecordingDurableResource.store.resolvePath(sessionDir);
  if (!resourceBelongsToClaim(screenRecordingDurableResource.store.read(resourcePath), claim)) {
    return 'retained';
  }
  return await recoverScreenRecordingResourceAfterDaemonLock({
    sessionsDir,
    resourcePath,
    gateway: params.gateway,
    scope: params.scope,
  });
}

function resourceBelongsToClaim<K extends string>(
  record:
    | { status: 'missing' }
    | { status: 'unreattachable' }
    | { status: 'decoded'; envelope: DurableResourceEnvelope<K> },
  claim: DeviceClaim,
): boolean {
  if (record.status === 'missing') return true;
  if (record.status === 'unreattachable') return false;
  return (
    record.envelope.sessionId === claim.session &&
    sameDeviceIdentity(record.envelope.device, deviceIdentity(deviceFromClaim(claim)))
  );
}

function deviceFromClaim(claim: DeviceClaim): DeviceInfo {
  return {
    ...deviceFieldsFromPublicPlatform(claim.device.platform),
    id: claim.device.id,
    name: claim.device.name,
    kind: claim.device.kind,
    ...(claim.device.target === undefined ? {} : { target: claim.device.target }),
    ...(claim.device.appleOs === undefined ? {} : { appleOs: claim.device.appleOs }),
    ...(claim.device.iosPhysicalDeviceBackend === undefined
      ? {}
      : { iosPhysicalDeviceBackend: claim.device.iosPhysicalDeviceBackend }),
  };
}
