import type { LeaseRequestStatus } from '@agent-device/contracts/managed-device-allocation';
import type { AllocationDecisionMode } from './allocation-operation-decision.ts';
import type { AllocationOperationRecord } from './allocation-operation-record.ts';
import type {
  AllocationJournalActionRunner,
  AllocationJournalResult,
  JournalContext,
} from './allocation-operation-journal-types.ts';
import { abandoned, blocked, uncertain } from './allocation-operation-journal-results.ts';
import type { AllocationActionRunnerContext } from './allocation-operation-journal-action-context.ts';
import {
  cleanupBinding,
  publishBinding,
  releaseLease,
} from './allocation-operation-journal-action-binding.ts';
import {
  transition,
  unknownAfterError,
} from './allocation-operation-journal-action-persistence.ts';

type ActionRunnerOptions = AllocationActionRunnerContext;

export function createAllocationJournalActionRunner(
  options: ActionRunnerOptions,
): AllocationJournalActionRunner {
  return Object.freeze({
    request: (record, context) => requestAllocation(options, record, context),
    supersede: (record, context) => supersedeAllocation(options, record, context),
    lookup: (record, mode, signal) => lookupAllocation(options, record, mode, signal),
    cancel: (record) => cancelAllocation(options, record),
    publish: (record, action, signal) => publishBinding(options, record, action, signal),
    cleanup: (record, action) => cleanupBinding(options, record, action),
    release: (record) => releaseLease(options, record),
  });
}

function requestAllocation(
  options: ActionRunnerOptions,
  record: AllocationOperationRecord,
  context: JournalContext,
): Promise<AllocationJournalResult> {
  const input = context.requestInput;
  return input
    ? dispatchRequest(options, record, context.signal, () => options.allocator.requestLease(input))
    : Promise.resolve(
        blocked('invalid-transition', 'allocation request input is unavailable', record),
      );
}

function supersedeAllocation(
  options: ActionRunnerOptions,
  record: AllocationOperationRecord,
  context: JournalContext,
): Promise<AllocationJournalResult> {
  const input = context.supersedeInput;
  return input
    ? dispatchRequest(options, record, context.signal, () =>
        options.allocator.supersedeLeaseRequest(input),
      )
    : Promise.resolve(blocked('invalid-transition', 'supersession input is unavailable', record));
}

function lookupAllocation(
  options: ActionRunnerOptions,
  record: AllocationOperationRecord,
  mode: AllocationDecisionMode,
  signal?: AbortSignal,
): Promise<AllocationJournalResult> {
  return options.allocator
    .getLeaseRequestStatus({ requesterId: record.requesterId, attemptKey: record.attemptKey })
    .then((status) =>
      settleAllocatorStatus(
        options,
        record,
        status,
        mode === 'release' ? 'release' : 'recover',
        signal,
      ),
    )
    .catch((error) => allocatorError(options, record, error, signal));
}

function cancelAllocation(
  options: ActionRunnerOptions,
  record: AllocationOperationRecord,
): Promise<AllocationJournalResult> {
  return options.allocator
    .cancelLeaseRequest({ requesterId: record.requesterId, attemptKey: record.attemptKey })
    .then((status) => settleAllocatorStatus(options, record, status, 'cancel'))
    .catch((error) => unknownAfterError(options, record, error));
}

function dispatchRequest(
  options: ActionRunnerOptions,
  record: AllocationOperationRecord,
  signal: AbortSignal | undefined,
  dispatch: () => Promise<LeaseRequestStatus>,
): Promise<AllocationJournalResult> {
  return transition(options, record, { kind: 'request-dispatched' }).then((dispatched) => {
    if (dispatched.status !== 'stored') return dispatched;
    if (signal?.aborted) return abandoned(dispatched.record);
    return dispatch()
      .then((status) =>
        settleAllocatorStatus(options, dispatched.record, status, 'continue', signal),
      )
      .catch((error) => allocatorError(options, dispatched.record, error, signal));
  });
}

function allocatorError(
  options: ActionRunnerOptions,
  record: AllocationOperationRecord,
  error: unknown,
  signal?: AbortSignal,
): Promise<AllocationJournalResult> {
  return signal?.aborted
    ? Promise.resolve(abandoned(record))
    : unknownAfterError(options, record, error);
}

async function settleAllocatorStatus(
  options: ActionRunnerOptions,
  record: AllocationOperationRecord,
  status: LeaseRequestStatus,
  followUp: 'continue' | 'recover' | 'release' | 'cancel',
  signal?: AbortSignal,
): Promise<AllocationJournalResult> {
  const persisted = await transition(options, record, { kind: 'allocator-status', status });
  if (persisted.status !== 'stored') return persisted;
  return settlePersistedStatus(options, persisted.record, followUp, signal);
}

function settlePersistedStatus(
  options: ActionRunnerOptions,
  record: AllocationOperationRecord,
  followUp: 'continue' | 'recover' | 'release' | 'cancel',
  signal?: AbortSignal,
): Promise<AllocationJournalResult> {
  if (signal?.aborted) return Promise.resolve(abandoned(record));
  if (record.phase.status === 'unknown') {
    return Promise.resolve(uncertain(record, 'allocator-uncertain', 'allocator status is unknown'));
  }
  if (record.phase.status === 'ambiguous') {
    return Promise.resolve(
      blocked('ambiguous-state', 'allocator status could not be matched to this operation', record),
    );
  }
  if (followUp === 'cancel') return settleCancellation(options, record);
  if (record.phase.status === 'pending') return Promise.resolve(options.project(record));
  return options.execute(record, followUp === 'release' ? 'release' : 'continue', { signal });
}

function settleCancellation(
  options: ActionRunnerOptions,
  record: AllocationOperationRecord,
): Promise<AllocationJournalResult> {
  return record.phase.status === 'granted'
    ? Promise.resolve(
        blocked(
          'already-granted',
          'allocator cancellation arrived after the lease was granted',
          record,
        ),
      )
    : Promise.resolve(options.project(record));
}
