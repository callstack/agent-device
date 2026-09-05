import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { acquireProcessLock } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { newAllocationOperation } from '../record-factory.ts';
import type { AllocationOperationRecord } from '../record.ts';
import { createAllocationOperationStore, type AllocationOperationStore } from '../store.ts';
import { ALLOCATION_LEASE, ALLOCATION_REQUEST } from './fixtures.ts';

const NOW = 1_700_000_000_000;

function fixture(): {
  root: string;
  store: AllocationOperationStore;
  record: AllocationOperationRecord;
} {
  const root = mkdtempForTestSync('allocation-operation-store-');
  const store = createAllocationOperationStore({ allocationsDir: path.join(root, 'allocations') });
  const record = newAllocationOperation({
    ...ALLOCATION_REQUEST,
    allocatorInstanceId: 'allocator-1',
    nowMs: NOW,
  });
  return { root, store, record };
}

test('publishes an operation durably under an independent hashed state directory and reconstructs it after restart', () => {
  const { root, store, record } = fixture();
  const created = store.create(record);
  assert.equal(created.status, 'created');
  const operationPath = store.resolvePath(record);
  assert.equal(path.dirname(path.dirname(operationPath)), path.join(root, 'allocations'));
  assert.equal(fs.statSync(operationPath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(operationPath)).length, 1);
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false);

  const restarted = createAllocationOperationStore({
    allocationsDir: path.join(root, 'allocations'),
  });
  const read = restarted.read(record);
  assert.deepEqual(read, { status: 'found', path: operationPath, record });
  assert.equal(read.status === 'found' ? Object.isFrozen(read.record.phase) : false, true);
});

test('uses the operation fence for transitions and refuses a stale writer without changing the file', async () => {
  const { store, record } = fixture();
  store.create(record);
  const dispatched = await store.transition(
    record,
    record.fence,
    { kind: 'request-dispatched' },
    NOW + 1,
  );
  assert.equal(dispatched.status, 'recorded');
  assert.equal(dispatched.status === 'recorded' ? dispatched.record.fence.generation : -1, 1);

  const stale = await store.transition(
    record,
    record.fence,
    { kind: 'allocator-unknown', message: 'lost response' },
    NOW + 2,
  );
  assert.equal(stale.status, 'fence-lost');
  assert.equal(stale.status === 'fence-lost' ? stale.current.fence.generation : -1, 1);

  const replay = await store.transition(
    record,
    dispatched.status === 'recorded' ? dispatched.record.fence : record.fence,
    { kind: 'request-dispatched' },
    NOW + 3,
  );
  assert.equal(replay.status, 'already-applied');
  assert.equal(replay.status === 'already-applied' ? replay.record.fence.generation : -1, 1);
});

test('a concurrent writer waits for the same operation lock before reading and fencing', async () => {
  const { store, record } = fixture();
  store.create(record);
  const owner = readCurrentOwnerIdentity();
  const operationPath = store.resolvePath(record);
  const release = await acquireProcessLock({
    lockDirPath: `${operationPath}.lock`,
    owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
    description: 'allocation operation test holder',
  });
  let settled = false;
  const pending = store
    .transition(record, record.fence, { kind: 'request-dispatched' }, NOW + 1)
    .finally(() => {
      settled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(settled, false);
  await release();
  assert.equal((await pending).status, 'recorded');
});

test('retains corrupt, unsupported, unfenced, and path-ambiguous records as diagnosable entries', () => {
  const { root, store, record } = fixture();
  store.create(record);
  const operationPath = store.resolvePath(record);
  const stored = JSON.parse(fs.readFileSync(operationPath, 'utf8')) as Record<string, unknown>;
  const cases = [
    ['corrupt', '{'],
    ['unsupported-version', JSON.stringify({ ...stored, schemaVersion: 8 })],
    ['unfenced', JSON.stringify({ ...stored, fence: { token: 'wrong', generation: 0 } })],
    [
      'ambiguous',
      JSON.stringify({ ...stored, phase: { status: 'pending' }, binding: 'published' }),
    ],
  ] as const;
  for (const [reason, contents] of cases) {
    fs.writeFileSync(operationPath, contents);
    const read = store.read(record);
    assert.equal(read.status, 'unreadable');
    assert.equal(read.status === 'unreadable' ? read.reason : undefined, reason);
  }

  fs.writeFileSync(operationPath, JSON.stringify({ ...stored, requesterId: 'other-requester' }));
  const pathMismatch = store.read(record);
  assert.equal(pathMismatch.status, 'unreadable');
  assert.equal(pathMismatch.status === 'unreadable' ? pathMismatch.reason : undefined, 'ambiguous');
  assert.equal(store.list().filter((entry) => entry.status === 'unreadable').length, 1);
  assert.equal(path.dirname(path.dirname(operationPath)), path.join(root, 'allocations'));
});

test('does not follow a symbolic-link destination', () => {
  const { root, store, record } = fixture();
  const operationPath = store.resolvePath(record);
  fs.mkdirSync(path.dirname(operationPath), { recursive: true });
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, '{}');
  fs.symlinkSync(outside, operationPath);
  assert.equal(store.create(record).status, 'unreadable');
  assert.equal(store.read(record).status, 'unreadable');
  assert.equal(fs.readFileSync(outside, 'utf8'), '{}');
});

test('retains a record as unreadable when its identity changes during read', () => {
  const { store, record } = fixture();
  assert.equal(store.create(record).status, 'created');
  const operationPath = store.resolvePath(record);
  const replacementPath = `${operationPath}.replacement`;
  fs.copyFileSync(operationPath, replacementPath);
  const realLstatSync = fs.lstatSync;
  let operationLstatCalls = 0;
  const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation(((
    target: fs.PathLike,
    options?: unknown,
  ) => {
    if (target.toString() === operationPath) {
      operationLstatCalls += 1;
      const resolved = operationLstatCalls === 2 ? replacementPath : target;
      return (realLstatSync as (path: fs.PathLike, options?: unknown) => fs.Stats)(
        resolved,
        options,
      );
    }
    return (realLstatSync as (path: fs.PathLike, options?: unknown) => fs.Stats)(target, options);
  }) as typeof fs.lstatSync);

  try {
    const read = store.read(record);
    assert.equal(read.status, 'unreadable');
    assert.equal(read.status === 'unreadable' ? read.reason : undefined, 'corrupt');
    assert.match(read.status === 'unreadable' ? read.message : '', /identity changed/);
  } finally {
    lstat.mockRestore();
    fs.rmSync(replacementPath, { force: true });
  }
});

test('does not follow a symbolic-link lane directory', () => {
  const { root, store, record } = fixture();
  const operationPath = store.resolvePath(record);
  const lanePath = path.dirname(operationPath);
  const outsideLane = path.join(root, 'outside-lane');
  fs.mkdirSync(path.dirname(lanePath), { recursive: true });
  fs.mkdirSync(outsideLane);
  fs.symlinkSync(outsideLane, lanePath, 'dir');

  assert.equal(store.create(record).status, 'unreadable');
  assert.equal(store.read(record).status, 'unreadable');
  assert.deepEqual(fs.readdirSync(outsideLane), []);
});

test('retains an unreadable lane enumeration instead of omitting its operations', () => {
  const { store, record } = fixture();
  assert.equal(store.create(record).status, 'created');
  const lanePath = path.dirname(store.resolvePath(record));
  const originalReaddirSync = fs.readdirSync;
  const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation((directory, options) => {
    if (directory.toString() === lanePath) {
      throw Object.assign(new Error('allocation lane is unreadable'), { code: 'EACCES' });
    }
    return originalReaddirSync(directory, options);
  });

  try {
    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, 'unreadable');
    assert.equal(listed[0]?.status === 'unreadable' ? listed[0].reason : undefined, 'corrupt');
  } finally {
    readdir.mockRestore();
  }
});

test('a terminal allocator outcome is retained rather than deleted', async () => {
  const { store, record } = fixture();
  store.create(record);
  const dispatched = await store.transition(
    record,
    record.fence,
    { kind: 'request-dispatched' },
    NOW + 1,
  );
  assert.equal(dispatched.status, 'recorded');
  const granted = await store.transition(
    record,
    dispatched.status === 'recorded' ? dispatched.record.fence : record.fence,
    {
      kind: 'allocator-outcome',
      outcome: {
        status: 'granted',
        lease: ALLOCATION_LEASE,
        identityIncarnationId: 'incarnation-1',
      },
    },
    NOW + 2,
  );
  assert.equal(granted.status, 'recorded');
  assert.equal(fs.existsSync(store.resolvePath(record)), true);
});
