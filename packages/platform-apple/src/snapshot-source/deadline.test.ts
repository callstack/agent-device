import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createSnapshotSourceDeadline, waitForSnapshotSourceDelay } from './deadline.ts';
import { SnapshotSourceError } from './errors.ts';

const WAIT_CODE = 'bridge-preparation-pending';

test('a stopped delay returns without spending the rest of the deadline', async () => {
  const stop = new AbortController();
  const deadline = createSnapshotSourceDeadline(60_000, undefined);
  const waiting = waitForSnapshotSourceDelay(deadline, 60_000, WAIT_CODE, stop.signal);

  const startedAt = Date.now();
  stop.abort();
  await waiting;
  assert.ok(Date.now() - startedAt < 5_000, 'a stopped wait does not sleep out its budget');
});

test('a delay started with its stop already aborted does not sleep', async () => {
  const stop = new AbortController();
  stop.abort();
  const deadline = createSnapshotSourceDeadline(60_000, undefined);

  const startedAt = Date.now();
  await waitForSnapshotSourceDelay(deadline, 60_000, WAIT_CODE, stop.signal);
  assert.ok(Date.now() - startedAt < 5_000);
});

test('an aborted caller signal stays typed cancellation next to a stop', async () => {
  const caller = new AbortController();
  const deadline = createSnapshotSourceDeadline(60_000, caller.signal);
  const waiting = waitForSnapshotSourceDelay(
    deadline,
    60_000,
    WAIT_CODE,
    new AbortController().signal,
  );

  caller.abort();
  await assert.rejects(waiting, (error: unknown) => {
    assert.ok(error instanceof SnapshotSourceError);
    assert.equal(error.failureKind, 'cancelled');
    assert.equal(error.failureCode, 'abort-signal');
    return true;
  });
});
