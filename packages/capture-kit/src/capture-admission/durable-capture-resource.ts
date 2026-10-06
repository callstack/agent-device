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
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DurableCaptureAdmissionLedger } from './durable-capture-admission-ledger.ts';
import { createNextDurableCaptureFence } from './durable-capture-start-preflight.ts';
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
  });
}
