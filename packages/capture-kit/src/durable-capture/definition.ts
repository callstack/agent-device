import type { JsonObject } from '@agent-device/contracts/client';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type {
  ResourceOwnershipFence,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DurableCaptureResourceStore } from './store.ts';

export type DurableCaptureSessionResource<K extends string, H extends AsyncDisposable> = Readonly<{
  handle: H;
  envelope: DurableResourceEnvelope<K>;
}>;

export type DurableCaptureSessionBinding<K extends string, H extends AsyncDisposable> = Readonly<{
  address: string;
  sessionDir: string;
  read(): DurableCaptureSessionResource<K, H> | undefined;
  assertAdoptable(): void;
  canPersist(): boolean;
  adopt(resource: DurableCaptureSessionResource<K, H>): void;
  clear(expected: DurableCaptureSessionResource<K, H>): 'cleared' | 'retired' | 'resource-changed';
}>;

/**
 * What a failed capture finish may do to a kind's material (ADR 0024 rule 6). A kind declares here
 * whether the shared coordinator's failed capture finish still earns a forced cleanup; a disposal
 * finish ignores this and always disposes.
 */
export type DurableCaptureFailedFinishPolicy =
  /**
   * The retry needs material forced cleanup would destroy, so a failed finish keeps every artifact
   * and leaves the record open for the next attempt.
   */
  | 'preserve-retry-material'
  /**
   * The retry needs nothing forced cleanup destroys, so a failed finish still disposes. A kind that
   * wants this says so where its definition is built.
   */
  | 'dispose-on-failed-finish';

/**
 * Why a finish is asked for. A `capture` finish tries to produce the resource's export and may keep
 * retry material under a preserving kind's policy; a `disposal` finish hands the resource back for
 * good — session teardown, or a start that replaces the resource — and disposes whatever a failed
 * finish left, because whatever follows expects the record settled rather than waiting for a retry.
 */
export type DurableCaptureFinishIntent = 'capture' | 'disposal';

/**
 * The session-free half of a definition. Recovery reattaches and terminalizes a persisted
 * record with no session in hand, so it names this and never the session type.
 */
export type DurableCaptureRecordDefinition<K extends string, C> = Readonly<{
  resourceKind: K;
  displayName: string;
  store: DurableCaptureResourceStore<K>;
  completionMetadata(result: C): JsonObject;
  /**
   * The completion this kind stored in a record that is already committed, or nothing it can serve.
   *
   * A committed record is the only account of an outcome a queued caller has never seen, so the kind
   * that wrote it is the one that reads it back: that caller is then answered with the outcome the
   * first finish produced instead of being refused, or driven through work that already happened. A
   * reader answers `undefined` for a stored shape it does not recognise, so a partial or foreign record
   * cannot yield a plausible-looking outcome.
   *
   * Optional because a kind whose stored metadata cannot carry its whole outcome has nothing honest to
   * replay; its callers then get the terminal refusal.
   */
  completionFromMetadata?(metadata: JsonObject | undefined): C | undefined | Promise<C | undefined>;
  failedFinishPolicy: DurableCaptureFailedFinishPolicy;
  messages: Readonly<{
    noActive: string;
    cleanupPendingHint: string;
  }>;
}>;

/**
 * What the mechanics observed about a failed adoption's cleanup. Reporting it keeps the
 * admission decision — block a replacement start, or clear an earlier block — with the caller.
 */
export type DurableCaptureCleanupOutcome =
  | { confirmed: true }
  | { confirmed: false; reason: string };

export type AdoptStartedDurableCaptureParams<K extends string, H extends AsyncDisposable> = {
  reportUndurableCleanup(device: DeviceInfo, outcome: DurableCaptureCleanupOutcome): void;
  binding: DurableCaptureSessionBinding<K, H>;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  pendingHandle: PendingTransferGuard<H>;
  envelope: DurableResourceEnvelope<K>;
  throwIfCanceled(): void;
};
