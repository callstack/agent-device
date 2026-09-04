import type { AllocationOperationRecord } from './allocation-operation-record.ts';
import type { AllocationOperationUnreadable } from './allocation-operation-store.ts';
import type {
  AllocationJournalBlockReason,
  AllocationJournalReason,
  AllocationJournalResult,
} from './allocation-operation-journal-types.ts';

export function blocked(
  reason: AllocationJournalBlockReason,
  message: string,
  record?: AllocationOperationRecord,
): AllocationJournalResult {
  return { status: 'blocked', reason, message, ...(record === undefined ? {} : { record }) };
}

export function abandoned(record: AllocationOperationRecord): AllocationJournalResult {
  return { status: 'abandoned', record };
}

export function uncertain(
  record: AllocationOperationRecord,
  reason: AllocationJournalReason,
  message: string,
): AllocationJournalResult {
  return { status: 'uncertain', record, reason, message };
}

export function cleanupPending(
  record: AllocationOperationRecord,
  message: string,
): AllocationJournalResult {
  return { status: 'cleanup-pending', record, reason: 'cleanup-uncertain', message };
}

export function unreadableResult(result: AllocationOperationUnreadable): AllocationJournalResult {
  return {
    status: 'unreadable',
    path: result.path,
    reason: result.reason,
    message: result.message,
    ...(result.version === undefined ? {} : { version: result.version }),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
