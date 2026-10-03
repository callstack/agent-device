import assert from 'node:assert/strict';
import { test } from 'vitest';
import { newAllocationOperation } from '../record.ts';
import { applyAllocationTransition } from '../transitions.ts';
import { decideAllocationAction } from '../decision.ts';
import { ALLOCATION_LEASE, ALLOCATION_REQUEST } from './fixtures.ts';

const NOW = 1_700_000_000_000;

function requested() {
  return newAllocationOperation({
    ...ALLOCATION_REQUEST,
    allocatorInstanceId: 'allocator-1',
    nowMs: NOW,
  });
}

function granted() {
  const pending = applyAllocationTransition(requested(), { kind: 'request-dispatched' }, NOW + 1);
  assert.equal(pending.status, 'applied');
  const result = applyAllocationTransition(
    pending.record,
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
  assert.equal(result.status, 'applied');
  return result.record;
}

test('new work may request once, while recovery of intent only looks up the allocator', () => {
  assert.equal(decideAllocationAction(requested(), 'new').kind, 'request');
  assert.equal(decideAllocationAction(requested(), 'recover').kind, 'lookup');
  const pending = applyAllocationTransition(requested(), { kind: 'request-dispatched' }, NOW + 1);
  assert.equal(pending.status, 'applied');
  assert.equal(decideAllocationAction(pending.record, 'recover').kind, 'lookup');
});

test('an allocator-unknown record never gets an implicit second request', () => {
  const record = applyAllocationTransition(
    requested(),
    { kind: 'allocator-unknown', message: 'response lost' },
    NOW + 1,
  );
  assert.equal(record.status, 'applied');
  const action = decideAllocationAction(record.record, 'recover');
  assert.deepEqual(action, {
    kind: 'lookup',
    ref: { requesterId: 'requester-a', attemptKey: 'attempt-1' },
  });
});

test('grants publish first, and release cleans the binding before calling the allocator', () => {
  const record = granted();
  assert.equal(decideAllocationAction(record, 'continue').kind, 'publish');
  const publishPending = applyAllocationTransition(
    record,
    { kind: 'binding-publish-pending' },
    NOW + 2,
  );
  assert.equal(publishPending.status, 'applied');
  assert.equal(decideAllocationAction(publishPending.record, 'continue').kind, 'blocked');
  assert.equal(decideAllocationAction(publishPending.record, 'recover').kind, 'cleanup');
  const published = applyAllocationTransition(
    publishPending.record,
    { kind: 'binding-published' },
    NOW + 3,
  );
  assert.equal(published.status, 'applied');
  const cleanup = decideAllocationAction(published.record, 'release');
  assert.equal(cleanup.kind, 'cleanup');
  const cleaned = applyAllocationTransition(published.record, { kind: 'binding-cleaned' }, NOW + 4);
  assert.equal(cleaned.status, 'applied');
  assert.deepEqual(decideAllocationAction(cleaned.record, 'release'), {
    kind: 'release',
    leaseId: 'lease-1',
  });
});

test('cancel and explicit supersession are allocator actions, not local terminal guesses', () => {
  assert.equal(decideAllocationAction(requested(), 'cancel').kind, 'cancel');
  assert.equal(decideAllocationAction(requested(), 'supersede').kind, 'supersede');
  assert.equal(decideAllocationAction(granted(), 'cancel').kind, 'blocked');
});
