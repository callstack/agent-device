import { isDeepStrictEqual } from 'node:util';
import type {
  LeaseRequestInput,
  ManagedDeviceAllocatorPort,
} from '@agent-device/contracts/managed-device-allocation';
import { newAllocationOperation } from './record-factory.ts';
import type { AllocationOperationRecord } from './record.ts';
import type { AllocationJournalResult } from './journal-types.ts';
import { blocked, errorMessage, unreadableResult } from './journal-results.ts';
import type { AllocationOperationStore } from './store.ts';

export type AllocationJournalLane = Readonly<{
  open(
    input: LeaseRequestInput,
  ): Readonly<{ record: AllocationOperationRecord; created: boolean }> | AllocationJournalResult;
  withLock(
    requesterId: string,
    task: () => Promise<AllocationJournalResult>,
  ): Promise<AllocationJournalResult>;
  nextRequestGeneration(requesterId: string): number;
}>;

type LaneDependencies = Readonly<{
  allocator: ManagedDeviceAllocatorPort;
  store: AllocationOperationStore;
  now: () => number;
}>;

export function createAllocationJournalLane(options: LaneDependencies): AllocationJournalLane {
  return Object.freeze({
    open: createOpen(options),
    withLock: createLaneLock(options.store),
    nextRequestGeneration: (requesterId) => nextRequestGeneration(options.store, requesterId),
  });
}

function createOpen(dependencies: LaneDependencies): AllocationJournalLane['open'] {
  return (input) => openLaneOperation(dependencies, input);
}

function createLaneLock(store: AllocationOperationStore): AllocationJournalLane['withLock'] {
  return (requesterId, task) =>
    store.withLaneLock(requesterId, task).catch((error) => {
      return blocked('persistence-failed', errorMessage(error));
    });
}

function openLaneOperation(
  dependencies: LaneDependencies,
  input: LeaseRequestInput,
): Readonly<{ record: AllocationOperationRecord; created: boolean }> | AllocationJournalResult {
  const candidate = buildCandidate(dependencies, input);
  if (isJournalResult(candidate)) return candidate;
  const existing = resolveExistingCandidate(
    dependencies.store.read(candidate),
    input,
    dependencies.allocator.instanceId,
  );
  if (existing) return existing;
  const conflict = laneConflict(dependencies.store, input.requesterId, input.requestGeneration);
  if (conflict) return conflict;
  return persistCandidate(dependencies.store, candidate, input, dependencies.allocator.instanceId);
}

function buildCandidate(
  dependencies: LaneDependencies,
  input: LeaseRequestInput,
): AllocationOperationRecord | AllocationJournalResult {
  try {
    return newAllocationOperation({
      requesterId: input.requesterId,
      requestGeneration: input.requestGeneration,
      attemptKey: input.attemptKey,
      allocatorInstanceId: dependencies.allocator.instanceId,
      shape: input.shape,
      deadlineAtMs: input.deadlineAtMs,
      admission: input.admission,
      ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
      nowMs: dependencies.now(),
    });
  } catch (error) {
    return blocked('payload-mismatch', errorMessage(error));
  }
}

function resolveExistingCandidate(
  existing: ReturnType<AllocationOperationStore['read']>,
  input: LeaseRequestInput,
  allocatorInstanceId: string,
):
  | Readonly<{ record: AllocationOperationRecord; created: boolean }>
  | AllocationJournalResult
  | undefined {
  if (existing.status === 'unreadable') return unreadableResult(existing);
  if (existing.status === 'missing') return undefined;
  return sameRequest(existing.record, input, allocatorInstanceId)
    ? { record: existing.record, created: false }
    : mismatchedCandidate(existing.record);
}

function persistCandidate(
  store: AllocationOperationStore,
  candidate: AllocationOperationRecord,
  input: LeaseRequestInput,
  allocatorInstanceId: string,
): Readonly<{ record: AllocationOperationRecord; created: boolean }> | AllocationJournalResult {
  let created: ReturnType<AllocationOperationStore['create']>;
  try {
    created = store.create(candidate);
  } catch (error) {
    return blocked('persistence-failed', errorMessage(error));
  }
  if (created.status === 'unreadable') return unreadableResult(created);
  return sameRequest(created.record, input, allocatorInstanceId)
    ? { record: created.record, created: created.status === 'created' }
    : mismatchedCandidate(created.record);
}

function mismatchedCandidate(record: AllocationOperationRecord): AllocationJournalResult {
  return blocked(
    'payload-mismatch',
    'allocation attempt key already names a different request',
    record,
  );
}

type LaneEntryInspection =
  | Readonly<{ highestGeneration: number; conflict?: AllocationOperationRecord }>
  | AllocationJournalResult;

function laneConflict(
  store: AllocationOperationStore,
  requesterId: string,
  requestGeneration: number,
): AllocationJournalResult | undefined {
  let highestGeneration = 0;
  for (const entry of store.list()) {
    const inspection = inspectLaneEntry(entry, requesterId);
    if (isJournalResult(inspection)) return inspection;
    highestGeneration = Math.max(highestGeneration, inspection.highestGeneration);
    if (inspection.conflict) return laneBusy(inspection.conflict);
  }
  return requestGeneration <= highestGeneration
    ? blocked(
        'payload-mismatch',
        'allocation request generation is not newer than durable lane history',
      )
    : undefined;
}

/** The lowest generation `laneConflict` admits over the records this lane can read. */
function nextRequestGeneration(store: AllocationOperationStore, requesterId: string): number {
  let highestGeneration = 0;
  for (const entry of store.list()) {
    const inspection = inspectLaneEntry(entry, requesterId);
    if (isJournalResult(inspection)) continue;
    highestGeneration = Math.max(highestGeneration, inspection.highestGeneration);
  }
  return highestGeneration + 1;
}

function inspectLaneEntry(
  entry: ReturnType<AllocationOperationStore['list']>[number],
  requesterId: string,
): LaneEntryInspection {
  if (entry.status === 'unreadable') return unreadableResult(entry);
  if (entry.status === 'missing' || entry.record.requesterId !== requesterId) {
    return { highestGeneration: 0 };
  }
  return {
    highestGeneration: entry.record.requestGeneration,
    ...(holdsAllocationLane(entry.record) ? { conflict: entry.record } : {}),
  };
}

function laneBusy(record: AllocationOperationRecord): AllocationJournalResult {
  return blocked(
    'lane-busy',
    'requester lane has an allocation operation that may still mutate the allocator',
    record,
  );
}

function isJournalResult(value: unknown): value is AllocationJournalResult {
  return typeof value === 'object' && value !== null && 'status' in value;
}

function sameRequest(
  record: AllocationOperationRecord,
  input: LeaseRequestInput,
  allocatorInstanceId: string,
): boolean {
  return (
    record.allocatorInstanceId === allocatorInstanceId &&
    record.requesterId === input.requesterId &&
    record.attemptKey === input.attemptKey &&
    record.requestGeneration === input.requestGeneration &&
    record.deadlineAtMs === input.deadlineAtMs &&
    record.admission === input.admission &&
    isDeepStrictEqual(record.shape, input.shape) &&
    isDeepStrictEqual(record.attribution, input.attribution)
  );
}

export function holdsAllocationLane(record: AllocationOperationRecord): boolean {
  if (record.phase.status !== 'granted') {
    return (
      record.phase.status === 'unresolved' ||
      record.phase.status === 'pending' ||
      record.phase.status === 'unknown'
    );
  }
  return record.release !== 'released';
}
