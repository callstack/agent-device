import type { JsonObject } from '@agent-device/contracts/client';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { LiveResourceHandle } from '@agent-device/contracts/durable-resource';
import type { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type {
  ResourceOwnershipFence,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DurableCaptureResourceStore } from './store.ts';

/**
 * The whole of the session store these mechanics touch: where a session's records live, and
 * how an updated session record is put back. The session type itself stays opaque — only a
 * definition's own `sessionSlot` looks inside it.
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
 * admission decision — block a replacement start, or clear an earlier block — with the caller.
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
