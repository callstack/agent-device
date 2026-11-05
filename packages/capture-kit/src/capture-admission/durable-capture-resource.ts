import path from 'node:path';
import {
  adoptStartedDurableCapture,
  finishLiveDurableCapture,
  finishRecoveredDurableCapture,
  forceCleanupLiveDurableCapture,
  recoverDurableCaptureResource,
  recoverDurableCaptureResourcesAfterDaemonLock,
  type AdoptStartedDurableCaptureParams,
  type DurableCaptureFinishIntent,
  type DurableCaptureRecoveryParams,
  type DurableCaptureRecordDefinition,
  type DurableCaptureSessionBinding,
  type FinishRecoveredDurableCaptureParams,
} from '../durable-capture/index.ts';
import type { LiveResourceHandle } from '@agent-device/contracts/durable-resource';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity, deviceIdentityKey, type DeviceInfo } from '@agent-device/kernel/device';
import type { DurableCaptureAdmissionLedger } from './durable-capture-admission-ledger.ts';
import {
  createNextDurableCaptureFence,
  listDurableCaptureStartConflicts,
} from './durable-capture-start-preflight.ts';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import type { DurableSessionResourceKind } from './durable-session-resource-kinds.ts';

export type { DurableCaptureFinishIntent, DurableSessionResourceKind };

type AdoptStartedSessionCaptureParams<K extends string, H extends AsyncDisposable> = Omit<
  AdoptStartedDurableCaptureParams<K, H>,
  'reportUndurableCleanup'
> &
  Readonly<{ admissionLedger: DurableCaptureAdmissionLedger }>;

type SessionCaptureRecoveryParams<K extends string, H extends LiveResourceHandle<C>, C> = Omit<
  DurableCaptureRecoveryParams<K, H, C>,
  'definition' | 'resolveSessionDir'
>;

/** The session binding owns its slot and path; the ledger owns failed-adoption admission. */
export function createDurableCaptureResource<
  K extends DurableSessionResourceKind,
  H extends LiveResourceHandle<C>,
  C,
>(definition: DurableCaptureRecordDefinition<K, C>) {
  const sessionResourcePath = (
    sessionStore: Readonly<{ resolveSessionDir(name: string): string }>,
    sessionName: string,
  ): string => definition.store.resolvePath(sessionStore.resolveSessionDir(sessionName));
  const recoveryParams = (
    params: SessionCaptureRecoveryParams<K, H, C>,
  ): DurableCaptureRecoveryParams<K, H, C> => ({
    definition,
    resolveSessionDir: (sessionId) => path.join(params.sessionsDir, safeSessionName(sessionId)),
    ...params,
  });

  return Object.freeze({
    store: definition.store,
    /** Where this session's record for this resource lives. */
    resourcePath: sessionResourcePath,
    createNextFence(params: {
      admissionLedger: DurableCaptureAdmissionLedger;
      resourcePath: string;
      device: DeviceInfo;
    }): ResourceOwnershipFence {
      return createNextDurableCaptureFence(definition, params);
    },
    adoptStarted(params: AdoptStartedSessionCaptureParams<K, H>): Promise<void> {
      return adoptStartedDurableCapture(
        definition,
        {
          ...params,
          reportUndurableCleanup: (device, outcome) => {
            if (outcome.confirmed) params.admissionLedger.clearUndurableCleanup(device);
            else params.admissionLedger.blockUndurableCleanup(device, outcome.reason);
          },
        },
        definition.store.resolvePath(params.binding.sessionDir),
      );
    },
    finishLive(params: {
      binding: DurableCaptureSessionBinding<K, H>;
      intent: DurableCaptureFinishIntent;
    }): Promise<C> {
      return finishLiveDurableCapture(
        definition,
        params,
        definition.store.resolvePath(params.binding.sessionDir),
      );
    },
    finishRecovered(params: FinishRecoveredDurableCaptureParams<K, H, C>): Promise<C> {
      return finishRecoveredDurableCapture(definition, params);
    },
    forceCleanupLive(params: { binding: DurableCaptureSessionBinding<K, H> }): Promise<void> {
      return forceCleanupLiveDurableCapture(definition, {
        ...params,
        resourcePath: definition.store.resolvePath(params.binding.sessionDir),
      });
    },
    recoverAll(params: SessionCaptureRecoveryParams<K, H, C>) {
      return recoverDurableCaptureResourcesAfterDaemonLock(recoveryParams(params));
    },
    recoverOne(params: SessionCaptureRecoveryParams<K, H, C>, resourcePath: string) {
      return recoverDurableCaptureResource(recoveryParams(params), resourcePath);
    },
    /**
     * Finishes the records on `device` that would refuse a start at `resourcePath` and whose
     * session the daemon no longer holds, as their own stop would, and runs exact-owner recovery
     * only for a record that cannot finish. A held session's record belongs to its own stop or
     * close. A record on another device is never recovered through the start device. A record
     * left open still refuses.
     */
    async settleStartConflicts(
      params: Omit<SessionCaptureRecoveryParams<K, H, C>, 'sessionsDir'> &
        Readonly<{
          resourcePath: string;
          device: DeviceInfo;
          holdsSession(sessionId: string): boolean;
        }>,
    ): Promise<void> {
      const { resourcePath, device, holdsSession, ...recovery } = params;
      const conflicts = listDurableCaptureStartConflicts(definition, resourcePath, device);
      const deviceKey = deviceIdentityKey(deviceIdentity(device));
      for (const record of conflicts.records) {
        if (holdsSession(record.envelope.sessionId)) continue;
        if (deviceIdentityKey(record.envelope.device) !== deviceKey) continue;
        try {
          await finishRecoveredDurableCapture(definition, {
            resourcePath: record.resourcePath,
            scope: recovery.scope,
            acquireControl: recovery.acquireControl,
          });
        } catch {
          await recoverDurableCaptureResource(
            recoveryParams({ ...recovery, sessionsDir: conflicts.sessionsDir }),
            record.resourcePath,
          );
        }
      }
    },
  });
}
