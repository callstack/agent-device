import fs from 'node:fs';
import path from 'node:path';
import type { AllocationOperationRecord, AllocationOperationRef } from './record.ts';
import type {
  AllocationOperationCreate,
  AllocationOperationRead,
  AllocationOperationUnreadable,
} from './store.ts';
import { decodeAllocationOperationRecord } from './record-codec.ts';
import {
  assertSafeAllocationDirectory,
  errorMessage,
  isAlreadyExists,
  publishAllocationRecord,
} from './store-filesystem.ts';
import { hash } from './store-lock.ts';
import { allocationOperationUnreadable } from './store-results.ts';

type ReadOperation = (
  recordPath: string,
  expectedRef?: AllocationOperationRef,
) => AllocationOperationRead;

export function createAllocationRecord(
  options: Readonly<{
    allocationsDir: string;
    record: AllocationOperationRecord;
    read: ReadOperation;
  }>,
): AllocationOperationCreate {
  const recordPath = path.join(
    options.allocationsDir,
    hash(options.record.requesterId),
    `${hash(options.record.attemptKey)}.json`,
  );
  const decoded = decodeAllocationOperationRecord(options.record);
  if (decoded.status !== 'decoded') return allocationOperationUnreadable(recordPath, decoded);
  const directoryError = prepareRecordDirectory(options.allocationsDir, recordPath);
  if (directoryError) return directoryError;
  const existing = options.read(recordPath, options.record);
  if (existing.status === 'found')
    return { status: 'exists', path: recordPath, record: existing.record };
  if (existing.status === 'unreadable') return existing;
  return publishNewRecord(recordPath, decoded.record, options.read);
}

function prepareRecordDirectory(
  allocationsDir: string,
  recordPath: string,
): AllocationOperationUnreadable | undefined {
  try {
    assertSafeAllocationDirectory(allocationsDir);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
    assertSafeAllocationDirectory(path.dirname(recordPath));
    return undefined;
  } catch (error) {
    return allocationOperationUnreadable(recordPath, {
      status: 'unreadable',
      reason: 'corrupt',
      message: errorMessage(error),
    });
  }
}

function publishNewRecord(
  recordPath: string,
  record: AllocationOperationRecord,
  read: ReadOperation,
): AllocationOperationCreate {
  try {
    publishAllocationRecord(recordPath, record, 'link-exclusive');
    return { status: 'created', path: recordPath, record };
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return resolveCreateRace(recordPath, read);
  }
}

function resolveCreateRace(recordPath: string, read: ReadOperation): AllocationOperationCreate {
  const existing = read(recordPath);
  if (existing.status === 'found') {
    return { status: 'exists', path: recordPath, record: existing.record };
  }
  if (existing.status === 'unreadable') return existing;
  return allocationOperationUnreadable(recordPath, {
    status: 'unreadable',
    reason: 'corrupt',
    message: 'allocation operation path disappeared during creation',
  });
}
