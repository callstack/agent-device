import crypto from 'node:crypto';
import { addAbortListener } from 'node:events';
import type {
  LeaseRefusal,
  ManagedDeviceAllocatorPort,
  ManagedShapeRequest,
} from '@agent-device/contracts/managed-device-allocation';
import type { AllocationBinding } from '@agent-device/managed-allocation/decision';
import {
  createAllocationOperationJournal,
  type AllocationJournalResult,
  type AllocationOperationJournal,
} from '@agent-device/managed-allocation/journal';
import type {
  AllocationOperationRecord,
  AllocationOperationRef,
} from '@agent-device/managed-allocation/record';
import type { AllocationOperationStore } from '@agent-device/managed-allocation/store';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { createManagedLeaseReachability } from '../../managed-device-reachability.ts';
import { MANAGED_COMMAND_TEARDOWN_TIMEOUT_MS } from './command-horizon.ts';
import { createManagedLeaseAdmission, type ManagedLeaseAdmission } from './lease-admission.ts';
import { startManagedLeaseKeepalive, type ManagedLeaseLoss } from './lease-keepalive.ts';

/** One published managed device: the job that holds it and the admission its commands run under. */
export type ManagedLeaseBinding = Readonly<{
  owner: string;
  shape: ManagedShapeRequest;
  admission: ManagedLeaseAdmission;
}>;

/**
 * Session handoff for a granted device. `publish` runs after the grant is durable and before the
 * binding is executable; `teardown` runs after the binding is fenced and before the allocator
 * lease is released, and must leave no runner or session executing against the device.
 */
export type ManagedLeaseHandoff = Readonly<{
  publish(binding: ManagedLeaseBinding): Promise<void>;
  teardown(binding: ManagedLeaseBinding): Promise<void>;
}>;

export type ManagedLeaseAcquireInput = Readonly<{
  owner: string;
  shape: ManagedShapeRequest;
  deadlineAtMs: number;
  signal?: AbortSignal;
}>;

export type ManagedLeaseUnavailableReason =
  | 'owner-busy'
  | 'shutting-down'
  | 'abandoned'
  | 'deadline-exceeded'
  | 'allocator-cancelled'
  | 'allocator-uncertain'
  | 'handoff-failed'
  | 'journal-blocked';

export type ManagedLeaseAcquisition =
  | Readonly<{ status: 'granted'; binding: ManagedLeaseBinding }>
  | Readonly<{ status: 'refused'; refusal: LeaseRefusal }>
  | Readonly<{ status: 'unavailable'; reason: ManagedLeaseUnavailableReason; message: string }>;

/** `uncertain` leaves the journal record for restart recovery to settle with the allocator. */
export type ManagedLeaseRelease =
  | Readonly<{ status: 'released' }>
  | Readonly<{ status: 'not-held' }>
  | Readonly<{ status: 'uncertain'; message: string }>;

export type ManagedLeaseCoordinator = AsyncDisposable &
  Readonly<{
    acquire(input: ManagedLeaseAcquireInput): Promise<ManagedLeaseAcquisition>;
    release(owner: string): Promise<ManagedLeaseRelease>;
    binding(owner: string): ManagedLeaseBinding | undefined;
  }>;

type OwnerEntry =
  | Readonly<{
      phase: 'acquiring';
      cancel: AbortController;
      settled: Promise<ManagedLeaseAcquisition>;
    }>
  | Readonly<{
      phase: 'held';
      ref: AllocationOperationRef;
      binding: ManagedLeaseBinding;
      keepalive: Disposable;
    }>
  | Readonly<{ phase: 'releasing'; settled: Promise<ManagedLeaseRelease> }>;

const DEFAULT_RENEW_INTERVAL_MS = 30_000;
const DEFAULT_RENEWAL_SAFETY_WINDOW_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Host-side lease coordination over the durable allocation journal (ADR 0021 §4, §7). One owner
 * is one verification job and the allocator requester: it holds at most one device, which stays
 * renewed between commands until `release`, and is torn down and released when the allocator
 * stops confirming it. Expiry of the Host lease itself belongs to its owner, which calls
 * `release`. Disposal stops renewal without releasing, leaving held leases to restart recovery.
 */
export function createManagedLeaseCoordinator(options: {
  store: AllocationOperationStore;
  allocator: ManagedDeviceAllocatorPort;
  handoff: ManagedLeaseHandoff;
  renewIntervalMs?: number;
  renewalSafetyWindowMs?: number;
  pollIntervalMs?: number;
  teardownTimeoutMs?: number;
}): ManagedLeaseCoordinator {
  const renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  const renewalSafetyWindowMs = options.renewalSafetyWindowMs ?? DEFAULT_RENEWAL_SAFETY_WINDOW_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const teardownTimeoutMs = options.teardownTimeoutMs ?? MANAGED_COMMAND_TEARDOWN_TIMEOUT_MS;
  const entries = new Map<string, OwnerEntry>();
  let disposed = false;
  const published = new Map<string, ManagedLeaseBinding>();

  const journal: AllocationOperationJournal = createAllocationOperationJournal({
    store: options.store,
    allocator: options.allocator,
    binding: {
      publish: async (allocation) => {
        const binding = bindingFor(allocation);
        // Recorded before the handoff so a failed publication is still torn down by cleanup.
        published.set(operationKey(allocation.operation), binding);
        await options.handoff.publish(binding);
      },
      cleanup: async (allocation) => {
        const key = operationKey(allocation.operation);
        const binding = published.get(key);
        if (!binding) return;
        binding.admission.fenceBinding('released');
        await options.handoff.teardown(binding);
        published.delete(key);
      },
    },
  });

  function bindingFor(allocation: AllocationBinding): ManagedLeaseBinding {
    const read = journal.read(allocation.operation);
    if (read.status !== 'found') {
      throw new Error('Managed allocation record is unavailable for its binding.');
    }
    const { record } = read;
    const admission = createManagedLeaseAdmission({
      allocator: options.allocator,
      grant: {
        requesterId: record.requesterId,
        requestGeneration: record.requestGeneration,
        attemptKey: record.attemptKey,
        identityIncarnationId: allocation.identityIncarnationId,
        state: 'granted',
        lease: allocation.lease,
      },
      reachability: createManagedLeaseReachability({
        platform: record.shape.platform,
        lease: allocation.lease,
      }),
      renewalSafetyWindowMs,
    });
    return Object.freeze({ owner: record.requesterId, shape: record.shape, admission });
  }

  async function acquire(input: ManagedLeaseAcquireInput): Promise<ManagedLeaseAcquisition> {
    if (disposed) return unavailable('shutting-down', 'The managed lease coordinator is closed.');
    if (entries.has(input.owner)) {
      return unavailable(
        'owner-busy',
        'This owner already holds or is acquiring a managed device.',
      );
    }
    const cancel = new AbortController();
    const settled = acquireFor(input, cancel);
    entries.set(input.owner, { phase: 'acquiring', cancel, settled });
    return await settled;
  }

  /** Settles with the owner's entry already moved to `held` or removed. */
  async function acquireFor(
    input: ManagedLeaseAcquireInput,
    cancel: AbortController,
  ): Promise<ManagedLeaseAcquisition> {
    const signal = input.signal ? AbortSignal.any([input.signal, cancel.signal]) : cancel.signal;
    const ref = { requesterId: input.owner, attemptKey: crypto.randomUUID() };
    let acquisition = await allocate(input, ref, signal);
    if (acquisition.status === 'granted' && signal.aborted) {
      acquisition = await abandon(ref, 'abandoned');
    }
    if (acquisition.status !== 'granted') {
      entries.delete(input.owner);
      return acquisition;
    }
    entries.set(input.owner, {
      phase: 'held',
      ref,
      binding: acquisition.binding,
      keepalive: startManagedLeaseKeepalive({
        admission: acquisition.binding.admission,
        intervalMs: renewIntervalMs,
        teardownTimeoutMs,
        onLost: (loss) => onLeaseLost(input.owner, loss),
      }),
    });
    return acquisition;
  }

  async function allocate(
    input: ManagedLeaseAcquireInput,
    ref: AllocationOperationRef,
    signal: AbortSignal,
  ): Promise<ManagedLeaseAcquisition> {
    let result = await journal.allocate({
      ...ref,
      requestGeneration: nextRequestGeneration(journal, ref.requesterId),
      shape: input.shape,
      deadlineAtMs: input.deadlineAtMs,
      admission: 'fail-fast',
      signal,
    });
    while (result.status === 'pending' || isAllocatorUncertain(result)) {
      if (signal.aborted) return await abandon(ref, 'abandoned');
      const remainingMs = input.deadlineAtMs - Date.now();
      if (remainingMs <= 0) return await abandon(ref, 'deadline-exceeded');
      await abortableDelay(Math.min(pollIntervalMs, remainingMs), signal);
      if (signal.aborted) return await abandon(ref, 'abandoned');
      result = await journal.recover(ref);
    }
    if (result.status === 'granted') {
      const binding = published.get(operationKey(ref));
      return binding
        ? { status: 'granted', binding }
        : unavailable('journal-blocked', 'Granted allocation has no published binding.');
    }
    return await settleUngranted(ref, result);
  }

  async function settleUngranted(
    ref: AllocationOperationRef,
    result: AllocationJournalResult,
  ): Promise<ManagedLeaseAcquisition> {
    if (result.status === 'refused') return refusalOf(result.record);
    if (result.status === 'abandoned') return await abandon(ref, 'abandoned');
    if (result.status === 'cleanup-pending') {
      const released = await journal.release(ref);
      return unavailable(
        released.status === 'released' ? 'handoff-failed' : 'allocator-uncertain',
        describeJournalResult(result),
      );
    }
    return unavailable(
      UNGRANTED_REASONS[result.status] ?? 'journal-blocked',
      describeJournalResult(result),
    );
  }

  /**
   * Gives back whatever the attempt reached: a pending request is cancelled, and a grant that
   * arrives first is torn down and released. An unconfirmed cancel or release stays journaled.
   */
  async function abandon(
    ref: AllocationOperationRef,
    reason: 'abandoned' | 'deadline-exceeded',
  ): Promise<ManagedLeaseAcquisition> {
    const cancelled = await journal.cancel(ref);
    const settled =
      cancelled.status === 'blocked' && cancelled.reason === 'already-granted'
        ? await journal.release(ref)
        : cancelled;
    if (settled.status === 'cancelled' || settled.status === 'released') {
      return unavailable(
        reason,
        reason === 'abandoned'
          ? 'The managed device request was abandoned.'
          : 'The allocator did not grant a device before the request deadline.',
      );
    }
    return unavailable('allocator-uncertain', describeJournalResult(settled));
  }

  async function release(owner: string): Promise<ManagedLeaseRelease> {
    const entry = entries.get(owner);
    if (!entry) return { status: 'not-held' };
    if (entry.phase === 'releasing') return await entry.settled;
    if (entry.phase === 'acquiring') {
      entry.cancel.abort();
      const acquisition = await entry.settled;
      return acquisition.status === 'unavailable' && acquisition.reason === 'allocator-uncertain'
        ? { status: 'uncertain', message: acquisition.message }
        : { status: 'released' };
    }
    entry.keepalive[Symbol.dispose]();
    const settled = releaseHeld(entry.ref);
    entries.set(owner, { phase: 'releasing', settled });
    try {
      return await settled;
    } finally {
      entries.delete(owner);
    }
  }

  async function releaseHeld(ref: AllocationOperationRef): Promise<ManagedLeaseRelease> {
    const result = await journal.release(ref);
    if (result.status === 'released') return { status: 'released' };
    const message = describeJournalResult(result);
    emitDiagnostic({
      level: 'warn',
      phase: 'managed_lease_release_uncertain',
      data: {
        requesterId: ref.requesterId,
        attemptKey: ref.attemptKey,
        status: result.status,
        message,
      },
    });
    return { status: 'uncertain', message };
  }

  function onLeaseLost(owner: string, loss: ManagedLeaseLoss): void {
    emitDiagnostic({
      level: 'warn',
      phase: 'managed_lease_lost',
      data: {
        requesterId: owner,
        reason: loss.reason,
        ...(loss.error ? { error: loss.error.message } : {}),
      },
    });
    void release(owner);
  }

  return Object.freeze({
    acquire,
    release,
    binding: (owner: string) => {
      const entry = entries.get(owner);
      return entry?.phase === 'held' ? entry.binding : undefined;
    },
    [Symbol.asyncDispose]: async () => {
      disposed = true;
      const pending: Promise<unknown>[] = [];
      for (const entry of entries.values()) {
        if (entry.phase === 'held') entry.keepalive[Symbol.dispose]();
        if (entry.phase === 'acquiring') {
          entry.cancel.abort();
          pending.push(entry.settled);
        }
        if (entry.phase === 'releasing') pending.push(entry.settled);
      }
      await Promise.allSettled(pending);
      entries.clear();
    },
  });
}

const UNGRANTED_REASONS: Partial<
  Record<AllocationJournalResult['status'], ManagedLeaseUnavailableReason>
> = {
  cancelled: 'allocator-cancelled',
  uncertain: 'allocator-uncertain',
};

function refusalOf(record: AllocationOperationRecord): ManagedLeaseAcquisition {
  return record.phase.status === 'refused'
    ? { status: 'refused', refusal: record.phase.refusal }
    : unavailable('journal-blocked', 'Refused allocation has no refusal.');
}

function nextRequestGeneration(journal: AllocationOperationJournal, requesterId: string): number {
  let highest = 0;
  for (const entry of journal.list()) {
    if (entry.status === 'found' && entry.record.requesterId === requesterId) {
      highest = Math.max(highest, entry.record.requestGeneration);
    }
  }
  return highest + 1;
}

function isAllocatorUncertain(result: AllocationJournalResult): boolean {
  return result.status === 'uncertain' && result.reason === 'allocator-uncertain';
}

function operationKey(ref: AllocationOperationRef): string {
  return JSON.stringify([ref.requesterId, ref.attemptKey]);
}

function describeJournalResult(result: AllocationJournalResult): string {
  return 'message' in result && result.message
    ? result.message
    : `Allocation journal ended in ${result.status}.`;
}

function unavailable(
  reason: ManagedLeaseUnavailableReason,
  message: string,
): ManagedLeaseAcquisition {
  return { status: 'unavailable', reason, message };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    const listener = addAbortListener(signal, done);
    function done() {
      clearTimeout(timer);
      listener[Symbol.dispose]();
      resolve();
    }
  });
}
