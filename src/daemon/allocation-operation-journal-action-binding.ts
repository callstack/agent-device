import type { AllocationAction } from './allocation-operation-decision.ts';
import type { AllocationOperationRecord } from './allocation-operation-record.ts';
import type { AllocationJournalResult } from './allocation-operation-journal-types.ts';
import {
  abandoned,
  blocked,
  cleanupPending,
  errorMessage,
  uncertain,
} from './allocation-operation-journal-results.ts';
import type { AllocationActionRunnerContext } from './allocation-operation-journal-action-context.ts';
import { transition } from './allocation-operation-journal-action-persistence.ts';

export async function publishBinding(
  options: AllocationActionRunnerContext,
  record: AllocationOperationRecord,
  action: Extract<AllocationAction, { kind: 'publish' }>,
  signal?: AbortSignal,
): Promise<AllocationJournalResult> {
  if (!options.binding) {
    return blocked('binding-unavailable', 'managed binding publisher is not configured', record);
  }
  if (record.binding !== 'unpublished') return options.project(record);
  const pending = await transition(options, record, { kind: 'binding-publish-pending' });
  if (pending.status !== 'stored') return pending;
  if (signal?.aborted) return abandoned(pending.record);
  try {
    await options.binding.publish(action.binding);
  } catch (error) {
    return persistCleanupFailure(options, pending.record, error);
  }
  const published = await transition(options, pending.record, { kind: 'binding-published' });
  if (published.status !== 'stored') return published;
  return signal?.aborted ? abandoned(published.record) : options.project(published.record);
}

export async function cleanupBinding(
  options: AllocationActionRunnerContext,
  record: AllocationOperationRecord,
  action: Extract<AllocationAction, { kind: 'cleanup' }>,
): Promise<AllocationJournalResult> {
  if (record.binding === 'unpublished') {
    const cleaned = await transition(options, record, { kind: 'binding-cleaned' });
    return cleaned.status === 'stored' ? releaseLease(options, cleaned.record) : cleaned;
  }
  if (!options.binding) {
    return blocked('binding-unavailable', 'managed binding cleaner is not configured', record);
  }
  try {
    await options.binding.cleanup(action.binding);
  } catch (error) {
    return persistCleanupFailure(options, record, error);
  }
  const cleaned = await transition(options, record, { kind: 'binding-cleaned' });
  return cleaned.status === 'stored' ? releaseLease(options, cleaned.record) : cleaned;
}

export async function releaseLease(
  options: AllocationActionRunnerContext,
  record: AllocationOperationRecord,
): Promise<AllocationJournalResult> {
  if (record.phase.status !== 'granted') return options.project(record);
  const pending = await transition(options, record, { kind: 'release-pending' });
  if (pending.status !== 'stored') return pending;
  if (pending.record.phase.status !== 'granted') {
    return blocked(
      'invalid-transition',
      'allocator release lost its granted lease',
      pending.record,
    );
  }
  try {
    await options.allocator.releaseLease({ leaseId: pending.record.phase.lease.id });
  } catch (error) {
    return uncertain(pending.record, 'release-uncertain', errorMessage(error));
  }
  const released = await transition(options, pending.record, { kind: 'allocator-released' });
  return released.status === 'stored' ? options.project(released.record) : released;
}

async function persistCleanupFailure(
  options: AllocationActionRunnerContext,
  record: AllocationOperationRecord,
  error: unknown,
): Promise<AllocationJournalResult> {
  const message = errorMessage(error);
  const pending = await transition(options, record, { kind: 'binding-cleanup-pending', message });
  return pending.status === 'stored' ? cleanupPending(pending.record, message) : pending;
}
