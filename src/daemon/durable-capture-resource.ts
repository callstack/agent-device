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
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';
import type { DurableSessionResourceKind } from './durable-session-resource-kinds.ts';

export type DurableCaptureSessionResource<K extends string, H extends AsyncDisposable> = Readonly<{
  handle: H;
  envelope: DurableResourceEnvelope<K>;
}>;

export type DurableCaptureSessionSlot<K extends string, H extends AsyncDisposable> = Readonly<{
  read(session: SessionState): DurableCaptureSessionResource<K, H> | undefined;
  replace(
    session: SessionState,
    resource: DurableCaptureSessionResource<K, H> | undefined,
  ): SessionState;
}>;

export type DurableCaptureResourceDefinition<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
> = Readonly<{
  resourceKind: K;
  displayName: string;
  store: DurableCaptureResourceStore<K>;
  sessionSlot: DurableCaptureSessionSlot<K, H>;
  completionMetadata(result: C): JsonObject;
  messages: Readonly<{
    noActive: string;
    cleanupPendingHint: string;
  }>;
}>;

export type AdoptStartedDurableCaptureParams<K extends string, H extends AsyncDisposable> = {
  admissionLedger: DurableCaptureAdmissionLedger;
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  pendingHandle: PendingTransferGuard<H>;
  envelope: DurableResourceEnvelope<K>;
  throwIfCanceled(): void;
};

export function createDurableCaptureResource<
  K extends DurableSessionResourceKind,
  H extends LiveResourceHandle<C>,
  C,
>(definition: DurableCaptureResourceDefinition<K, H, C>) {
  const resourcePath = (sessionStore: SessionStore, sessionName: string): string =>
    definition.store.resolvePath(sessionStore.resolveSessionDir(sessionName));

  return Object.freeze({
    store: definition.store,
    createNextFence(params: {
      admissionLedger: DurableCaptureAdmissionLedger;
      resourcePath: string;
      device: DeviceInfo;
    }): ResourceOwnershipFence {
      return createNextDurableCaptureFence(definition, params);
    },
    adoptStarted(params: AdoptStartedDurableCaptureParams<K, H>): Promise<void> {
      return adoptStartedDurableCapture(
        definition,
        params,
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
    recoverAll(params: Omit<DurableCaptureRecoveryParams<K, H, C>, 'definition'>) {
      return recoverDurableCaptureResourcesAfterDaemonLock({ definition, ...params });
    },
    recoverOne(
      params: Omit<DurableCaptureRecoveryParams<K, H, C>, 'definition'>,
      resourcePath: string,
    ) {
      return recoverDurableCaptureResource({ definition, ...params }, resourcePath);
    },
  });
}
