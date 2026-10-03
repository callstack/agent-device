import type { AllocationOperationRecord } from './record.ts';
import type { AllocationOperationUnreadable, AllocationOperationWrite } from './store.ts';
import { decodeAllocationOperationRecord } from './record-codec.ts';

export function allocationOperationUnreadable(
  recordPath: string,
  result: Extract<ReturnType<typeof decodeAllocationOperationRecord>, { status: 'unreadable' }>,
): AllocationOperationUnreadable {
  return {
    status: 'unreadable',
    path: recordPath,
    reason: result.reason,
    message: result.message,
    ...(result.version === undefined ? {} : { version: result.version }),
  };
}

export type StoredAllocationTransition = Readonly<{
  status: 'applied' | 'already-applied' | 'already-terminal';
  record: AllocationOperationRecord;
}>;

export function allocationOperationWriteResult(
  recordPath: string,
  result: StoredAllocationTransition,
): AllocationOperationWrite {
  return result.status === 'applied'
    ? { status: 'recorded', path: recordPath, record: result.record }
    : { status: result.status, path: recordPath, record: result.record };
}
