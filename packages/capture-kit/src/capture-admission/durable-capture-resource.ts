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
  type DurableCaptureResourceDefinition,
  type DurableCaptureSessionStore,
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

type AdoptStartedSessionCaptureParams<K extends string, H extends AsyncDisposable, S> = Omit<
  AdoptStartedDurableCaptureParams<K, H, S>,
  'reportUndurableCleanup'
> &
  Readonly<{ admissionLedger: DurableCaptureAdmissionLedger }>;

type SessionCaptureRecoveryParams<K extends string, H extends LiveResourceHandle<C>, C> = Omit<
  DurableCaptureRecoveryParams<K, H, C>,
  'definition' | 'resolveSessionDir'
>;

/**
 * Where the shared durable-capture mechanics meet the two authorities that stay with the session
 * owner: the admission ledger, which decides whether a failed adoption blocks a replacement start,
 * and the session store, whose naming rule turns a session id into the one directory its records
 * may occupy. The session record itself stays opaque behind `S`; only the definition's own
 * `sessionSlot` looks inside it.
 */
export function createDurableCaptureResource<
  K extends DurableSessionResourceKind,
  H extends LiveResourceHandle<C>,
  C,
  S,
>(definition: DurableCaptureResourceDefinition<K, H, C, S>) {
  const sessionResourcePath = (
    sessionStore: DurableCaptureSessionStore<S>,
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
    adoptStarted(params: AdoptStartedSessionCaptureParams<K, H, S>): Promise<void> {
      return adoptStartedDurableCapture(
        definition,
        {
          ...params,
          reportUndurableCleanup: (device, outcome) => {
            if (outcome.confirmed) params.admissionLedger.clearUndurableCleanup(device);
            else params.admissionLedger.blockUndurableCleanup(device, outcome.reason);
          },
        },
        sessionResourcePath(params.sessionStore, params.sessionName),
      );
    },
    finishLive(params: {
      session: S;
      sessionName: string;
      sessionStore: DurableCaptureSessionStore<S>;
      intent: DurableCaptureFinishIntent;
    }): Promise<C> {
      return finishLiveDurableCapture(
        definition,
        params,
        sessionResourcePath(params.sessionStore, params.sessionName),
      );
    },
    finishRecovered(params: FinishRecoveredDurableCaptureParams<K, H, C>): Promise<C> {
      return finishRecoveredDurableCapture(definition, params);
    },
    forceCleanupLive(params: {
      session: S;
      sessionName?: string;
      sessionStore?: DurableCaptureSessionStore<S>;
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
