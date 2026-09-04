import { AppError } from '@agent-device/kernel/errors';
import type {
  AllocationOperationRecord,
  AllocationTransition,
} from './allocation-operation-record.ts';
import type {
  AllocationJournalResult,
  PersistedTransition,
} from './allocation-operation-journal-types.ts';
import type { AllocationOperationStore } from './allocation-operation-store.ts';
import {
  blocked,
  errorMessage,
  uncertain,
  unreadableResult,
} from './allocation-operation-journal-results.ts';
import type { AllocationActionRunnerContext } from './allocation-operation-journal-action-context.ts';

export async function transition(
  options: AllocationActionRunnerContext,
  record: AllocationOperationRecord,
  transitionInput: AllocationTransition,
): Promise<PersistedTransition> {
  try {
    const result = await options.store.transition(
      { requesterId: record.requesterId, attemptKey: record.attemptKey },
      record.fence,
      transitionInput,
      options.now(),
    );
    return mapTransitionResult(result, record);
  } catch (error) {
    return transitionError(record, error);
  }
}

function mapTransitionResult(
  result: Awaited<ReturnType<AllocationOperationStore['transition']>>,
  record: AllocationOperationRecord,
): PersistedTransition {
  if (
    result.status === 'recorded' ||
    result.status === 'already-applied' ||
    result.status === 'already-terminal'
  ) {
    return { status: 'stored', record: result.record };
  }
  if (result.status === 'fence-lost') {
    return blocked(
      'fence-lost',
      'allocation operation was changed by another writer',
      result.current,
    );
  }
  if (result.status === 'missing') {
    return blocked('operation-missing', 'allocation operation record is missing', record);
  }
  if (result.status === 'unreadable') return unreadableResult(result);
  return blocked('persistence-failed', 'allocation transition did not produce a result', record);
}

function transitionError(record: AllocationOperationRecord, error: unknown): PersistedTransition {
  if (error instanceof AppError && error.details?.reason === 'transition-invalid') {
    return blocked('invalid-transition', error.message, record);
  }
  return blocked('persistence-failed', errorMessage(error), record);
}

export async function unknownAfterError(
  options: AllocationActionRunnerContext,
  record: AllocationOperationRecord,
  error: unknown,
): Promise<AllocationJournalResult> {
  const message = errorMessage(error);
  const persisted = await transition(options, record, { kind: 'allocator-unknown', message });
  if (persisted.status !== 'stored') return persisted;
  return persisted.record.phase.status === 'unknown'
    ? uncertain(persisted.record, 'allocator-uncertain', message)
    : options.project(persisted.record);
}
