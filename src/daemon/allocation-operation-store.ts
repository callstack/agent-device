import fs from 'node:fs';
import path from 'node:path';
import type {
  AllocationOperationRecord,
  AllocationOperationRef,
  AllocationTransition,
} from './allocation-operation-record.ts';
import { applyAllocationTransition } from './allocation-operation-record-transition.ts';
import { decodeAllocationOperationRecord } from './allocation-operation-record-codec.ts';
import { createAllocationRecord } from './allocation-operation-store-creation.ts';
import {
  errorMessage,
  inspectAllocationOperationDirectories,
  isMissingFile,
  listAllocationOperationPaths,
  publishAllocationRecord,
} from './allocation-operation-store-filesystem.ts';
import {
  acquireAllocationStoreLock,
  createAllocationStoreLaneLock,
  hash,
} from './allocation-operation-store-lock.ts';
import {
  allocationOperationUnreadable,
  allocationOperationWriteResult,
} from './allocation-operation-store-results.ts';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';

export type AllocationOperationUnreadable = Readonly<{
  status: 'unreadable';
  path: string;
  reason: 'corrupt' | 'unsupported-version' | 'ambiguous' | 'unfenced';
  message: string;
  version?: number;
}>;

export type AllocationOperationRead =
  | Readonly<{ status: 'missing'; path: string }>
  | Readonly<{ status: 'found'; path: string; record: AllocationOperationRecord }>
  | AllocationOperationUnreadable;

export type AllocationOperationCreate =
  | Readonly<{ status: 'created'; path: string; record: AllocationOperationRecord }>
  | Readonly<{ status: 'exists'; path: string; record: AllocationOperationRecord }>
  | AllocationOperationUnreadable;

export type AllocationOperationWrite =
  | Readonly<{ status: 'recorded'; path: string; record: AllocationOperationRecord }>
  | Readonly<{ status: 'already-applied'; path: string; record: AllocationOperationRecord }>
  | Readonly<{ status: 'already-terminal'; path: string; record: AllocationOperationRecord }>
  | Readonly<{ status: 'fence-lost'; path: string; current: AllocationOperationRecord }>
  | AllocationOperationRead;

export type AllocationOperationStore = Readonly<{
  allocationsDir: string;
  resolvePath(ref: AllocationOperationRef): string;
  create(record: AllocationOperationRecord): AllocationOperationCreate;
  read(ref: AllocationOperationRef): AllocationOperationRead;
  withLaneLock<T>(requesterId: string, task: () => Promise<T>): Promise<T>;
  transition(
    ref: AllocationOperationRef,
    expectedFence: ResourceOwnershipFence,
    transition: AllocationTransition,
    nowMs: number,
  ): Promise<AllocationOperationWrite>;
  list(): AllocationOperationRead[];
}>;

export function createAllocationOperationStore(options: {
  allocationsDir: string;
}): AllocationOperationStore {
  const allocationsDir = path.resolve(options.allocationsDir);

  return Object.freeze({
    allocationsDir,
    resolvePath: (ref) => operationPath(allocationsDir, ref),
    create: (record) => createAllocationRecord({ allocationsDir, record, read: readPath }),
    read: (ref) => readPath(operationPath(allocationsDir, ref), ref),
    withLaneLock: createAllocationStoreLaneLock(allocationsDir),
    transition: (ref, expectedFence, transition, nowMs) =>
      transitionRecord(allocationsDir, ref, expectedFence, transition, nowMs),
    list: () => listRecords(allocationsDir),
  });
}

async function transitionRecord(
  allocationsDir: string,
  ref: AllocationOperationRef,
  expectedFence: ResourceOwnershipFence,
  transition: AllocationTransition,
  nowMs: number,
): Promise<AllocationOperationWrite> {
  const recordPath = operationPath(allocationsDir, ref);
  const release = await acquireAllocationStoreLock(
    `${recordPath}.lock`,
    `allocation operation ${ref.requesterId}/${ref.attemptKey}`,
  );
  try {
    return applyStoredTransition(recordPath, ref, expectedFence, transition, nowMs);
  } finally {
    await release();
  }
}

function applyStoredTransition(
  recordPath: string,
  ref: AllocationOperationRef,
  expectedFence: ResourceOwnershipFence,
  transition: AllocationTransition,
  nowMs: number,
): AllocationOperationWrite {
  const current = readPath(recordPath, ref);
  if (current.status !== 'found') return current;
  if (!sameFence(current.record.fence, expectedFence)) {
    return { status: 'fence-lost', path: recordPath, current: current.record };
  }
  const result = applyAllocationTransition(current.record, transition, nowMs);
  if (result.status === 'applied') publishAllocationRecord(recordPath, result.record, 'replace');
  return allocationOperationWriteResult(recordPath, result);
}

function listRecords(allocationsDir: string): AllocationOperationRead[] {
  return listAllocationOperationPaths(allocationsDir).map((entry) =>
    entry.status === 'unreadable' ? corruptRecord(entry.path, entry.message) : readPath(entry.path),
  );
}

function operationPath(allocationsDir: string, ref: AllocationOperationRef): string {
  return path.join(allocationsDir, hash(ref.requesterId), `${hash(ref.attemptKey)}.json`);
}

type RawRecordRead =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'unreadable'; message: string }>
  | Readonly<{ status: 'value'; value: unknown }>;

function readPath(
  recordPath: string,
  expectedRef?: AllocationOperationRef,
): AllocationOperationRead {
  const parentState = inspectAllocationOperationDirectories(recordPath);
  if (parentState === 'missing') return { status: 'missing', path: recordPath };
  if (parentState !== null) return corruptRecord(recordPath, parentState);
  const raw = readRawRecord(recordPath);
  if (raw.status === 'missing') return { status: 'missing', path: recordPath };
  if (raw.status === 'unreadable') return corruptRecord(recordPath, raw.message);
  const referenceError = validateRawReference(raw.value, expectedRef);
  if (referenceError) return allocationOperationUnreadable(recordPath, referenceError);
  const decoded = decodeAllocationOperationRecord(raw.value);
  if (decoded.status !== 'decoded') return allocationOperationUnreadable(recordPath, decoded);
  return validateDecodedRecord(recordPath, decoded.record, expectedRef);
}

function readRawRecord(recordPath: string): RawRecordRead {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(recordPath);
  } catch (error) {
    return isMissingFile(error)
      ? { status: 'missing' }
      : { status: 'unreadable', message: errorMessage(error) };
  }
  if (!stats.isFile()) {
    return {
      status: 'unreadable',
      message: stats.isSymbolicLink()
        ? 'allocation operation path is a symbolic link'
        : 'allocation operation path is not a regular file',
    };
  }
  try {
    return { status: 'value', value: JSON.parse(fs.readFileSync(recordPath, 'utf8')) as unknown };
  } catch (error) {
    return { status: 'unreadable', message: errorMessage(error) };
  }
}

function validateRawReference(
  value: unknown,
  expectedRef: AllocationOperationRef | undefined,
): { status: 'unreadable'; reason: 'ambiguous'; message: string } | undefined {
  if (!expectedRef || value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (
    isVerbatimId(raw.requesterId) &&
    isVerbatimId(raw.attemptKey) &&
    (raw.requesterId !== expectedRef.requesterId || raw.attemptKey !== expectedRef.attemptKey)
  ) {
    return {
      reason: 'ambiguous',
      status: 'unreadable',
      message: 'allocation operation record does not match its requested reference',
    };
  }
  return undefined;
}

function validateDecodedRecord(
  recordPath: string,
  record: AllocationOperationRecord,
  expectedRef: AllocationOperationRef | undefined,
): AllocationOperationRead {
  const ref = expectedRef ?? record;
  const expectedPath = operationPath(path.dirname(path.dirname(recordPath)), ref);
  if (
    record.requesterId !== ref.requesterId ||
    record.attemptKey !== ref.attemptKey ||
    recordPath !== expectedPath
  ) {
    return allocationOperationUnreadable(recordPath, {
      status: 'unreadable',
      reason: 'ambiguous',
      message: 'allocation operation record does not match its durable path',
    });
  }
  return { status: 'found', path: recordPath, record };
}

function corruptRecord(recordPath: string, message: string): AllocationOperationUnreadable {
  return allocationOperationUnreadable(recordPath, {
    status: 'unreadable',
    reason: 'corrupt',
    message,
  });
}

function sameFence(left: ResourceOwnershipFence, right: ResourceOwnershipFence): boolean {
  return left.token === right.token && left.generation === right.generation;
}

function isVerbatimId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}
