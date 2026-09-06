import path from 'node:path';
import {
  adoptStartedDurableCapture,
  finishLiveDurableCapture,
  finishRecoveredDurableCapture,
  forceCleanupLiveDurableCapture,
  recoverDurableCaptureResource,
  recoverDurableCaptureResourcesAfterDaemonLock,
  type AdoptStartedDurableCaptureParams,
  type DurableCaptureRecoveryParams,
  type DurableCaptureResourceDefinition,
  type DurableCaptureSessionStore,
  type FinishRecoveredDurableCaptureParams,
} from '@agent-device/capture-kit/durable-capture';
import type { LiveResourceHandle } from '@agent-device/contracts/durable-resource';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DurableCaptureAdmissionLedger } from './durable-capture-admission-ledger.ts';
import { createNextDurableCaptureFence } from './durable-capture-start-preflight.ts';
import { safeSessionName } from './session-paths.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './session-state.ts';
import type { DurableSessionResourceKind } from './durable-session-resource-kinds.ts';

type AdoptStartedSessionCaptureParams<K extends string, H extends AsyncDisposable> = Omit<
  AdoptStartedDurableCaptureParams<K, H, SessionState>,
  'reportUndurableCleanup'
> &
  Readonly<{ admissionLedger: DurableCaptureAdmissionLedger }>;

type SessionCaptureRecoveryParams<K extends string, H extends LiveResourceHandle<C>, C> = Omit<
  DurableCaptureRecoveryParams<K, H, C>,
  'definition' | 'resolveSessionDir'
>;

/**
 * Where the shared durable-capture mechanics meet the two authorities that stay daemon policy:
 * the admission ledger, which decides whether a failed adoption blocks a replacement start, and
 * the session store, whose naming rule turns a session id into the one directory its records
 * may occupy.
 */
export function createDurableCaptureResource<
  K extends DurableSessionResourceKind,
  H extends LiveResourceHandle<C>,
  C,
>(definition: DurableCaptureResourceDefinition<K, H, C, SessionState>) {
  const resourcePath = (
    sessionStore: DurableCaptureSessionStore<SessionState>,
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
        resourcePath(params.sessionStore, params.sessionName),
      );
    },
    finishLive(params: {
      session: SessionState;
      sessionName: string;
      sessionStore: SessionStore;
    }): Promise<C> {
      return finishLiveDurableCapture(
        definition,
        params,
        resourcePath(params.sessionStore, params.sessionName),
      );
    },
    finishRecovered(params: FinishRecoveredDurableCaptureParams<K, H, C>): Promise<C> {
      return finishRecoveredDurableCapture(definition, params);
    },
    forceCleanupLive(params: {
      session: SessionState;
      sessionName?: string;
      sessionStore?: SessionStore;
      resourcePath: string;
    }): Promise<void> {
      return forceCleanupLiveDurableCapture(definition, params);
    },
    recoverAll(params: SessionCaptureRecoveryParams<K, H, C>) {
      return recoverDurableCaptureResourcesAfterDaemonLock(recoveryParams(params));
    },
    recoverOne(params: SessionCaptureRecoveryParams<K, H, C>, resourcePath: string) {
      return recoverDurableCaptureResource(recoveryParams(params), resourcePath);
    },
  });
}
