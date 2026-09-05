import type { AllocationOperationRecord } from './record.ts';
import type { AllocationJournalResult } from './journal-types.ts';
import { blocked, uncertain } from './journal-results.ts';

export function projectAllocationRecord(
  record: AllocationOperationRecord,
): AllocationJournalResult {
  if (record.phase.status === 'unresolved' || record.phase.status === 'pending') {
    return { status: 'pending', record };
  }
  if (record.phase.status === 'unknown') {
    return uncertain(record, 'allocator-uncertain', record.phase.message);
  }
  if (record.phase.status === 'ambiguous') {
    return blocked('ambiguous-state', record.phase.message, record);
  }
  if (record.phase.status === 'granted') return projectGrantedRecord(record);
  return projectTerminalRecord(record);
}

function projectGrantedRecord(record: AllocationOperationRecord): AllocationJournalResult {
  return record.release === 'released'
    ? { status: 'released', record }
    : { status: 'granted', record };
}

function projectTerminalRecord(record: AllocationOperationRecord): AllocationJournalResult {
  switch (record.phase.status) {
    case 'refused':
      return { status: 'refused', record };
    case 'superseded':
      return { status: 'superseded', record };
    case 'cancelled':
      return { status: 'cancelled', record };
    default:
      return blocked(
        'ambiguous-state',
        'allocation operation has an unsupported terminal state',
        record,
      );
  }
}
