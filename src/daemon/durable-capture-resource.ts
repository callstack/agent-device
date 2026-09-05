import path from 'node:path';
import type { JsonObject } from '@agent-device/contracts/client';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { LiveResourceHandle } from '@agent-device/contracts/durable-resource';
import type { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type {
  ResourceOwnershipFence,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DurableCaptureAdmissionLedger } from './durable-capture-admission-ledger.ts';
import { adoptStartedDurableCapture } from './durable-capture-resource-adoption.ts';
import {
  finishLiveDurableCapture,
  forceCleanupLiveDurableCapture,
} from './durable-capture-resource-transitions.ts';
import type { DurableCaptureResourceStore } from './durable-capture-resource-store.ts';
import { createNextDurableCaptureFence } from './durable-capture-start-preflight.ts';
import {
  recoverDurableCaptureResource,
  recoverDurableCaptureResourcesAfterDaemonLock,
  type DurableCaptureRecoveryParams,
} from './durable-capture-resource-recovery.ts';
import {
  finishRecoveredDurableCapture,
  type FinishRecoveredDurableCaptureParams,
} from './durable-capture-resource-finish-recovered.ts';
import { safeSessionName } from './session-paths.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';
import type { DurableSessionResourceKind } from './durable-session-resource-kinds.ts';

/**
 * The whole of the session store the durable-capture mechanics touch: where a session's
 * records live, and how an updated session record is put back.
 */
export type DurableCaptureSessionStore<S> = Readonly<{
  set(name: string, session: S): void;
  resolveSessionDir(name: string): string;
}>;

export type DurableCaptureSessionResource<K extends string, H extends AsyncDisposable> = Readonly<{
  handle: H;
  envelope: DurableResourceEnvelope<K>;
}>;

export type DurableCaptureSessionSlot<K extends string, H extends AsyncDisposable, S> = Readonly<{
  read(session: S): DurableCaptureSessionResource<K, H> | undefined;
  replace(session: S, resource: DurableCaptureSessionResource<K, H> | undefined): S;
}>;

/**
 * The session-free half of a definition. Recovery reattaches and terminalizes a persisted
 * record with no session in hand, so it names this and never the session type.
 */
export type DurableCaptureRecordDefinition<K extends string, C> = Readonly<{
  resourceKind: K;
  displayName: string;
  store: DurableCaptureResourceStore<K>;
  completionMetadata(result: C): JsonObject;
  messages: Readonly<{
    noActive: string;
    cleanupPendingHint: string;
  }>;
}>;

export type DurableCaptureResourceDefinition<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
  S,
> = DurableCaptureRecordDefinition<K, C> &
  Readonly<{ sessionSlot: DurableCaptureSessionSlot<K, H, S> }>;

/**
 * What the mechanics observed about a failed adoption's cleanup. Reporting it keeps the
 * admission decision — block a replacement start, or clear an earlier block — with the daemon.
 */
export type DurableCaptureCleanupOutcome =
  | { confirmed: true }
  | { confirmed: false; reason: string };

export type AdoptStartedDurableCaptureParams<K extends string, H extends AsyncDisposable, S> = {
  reportUndurableCleanup(device: DeviceInfo, outcome: DurableCaptureCleanupOutcome): void;
  session: S;
  sessionName: string;
  sessionStore: DurableCaptureSessionStore<S>;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  pendingHandle: PendingTransferGuard<H>;
  envelope: DurableResourceEnvelope<K>;
  throwIfCanceled(): void;
};

type AdoptStartedSessionCaptureParams<K extends string, H extends AsyncDisposable> = Omit<
  AdoptStartedDurableCaptureParams<K, H, SessionState>,
  'reportUndurableCleanup'
> &
  Readonly<{ admissionLedger: DurableCaptureAdmissionLedger }>;

type SessionCaptureRecoveryParams<K extends string, H extends LiveResourceHandle<C>, C> = Omit<
  DurableCaptureRecoveryParams<K, H, C>,
  'definition' | 'resolveSessionDir'
>;

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
