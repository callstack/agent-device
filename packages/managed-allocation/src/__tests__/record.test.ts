import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { LeaseRequestStatus } from '@agent-device/contracts/managed-device-allocation';
import { managedBindingFence } from '@agent-device/contracts/platform-runtime';
import { AppError } from '@agent-device/kernel/errors';
import {
  ALLOCATION_OPERATION_SCHEMA_VERSION,
  bindingFenceFor,
  decodeAllocationOperationRecord,
  newAllocationOperation,
  type AllocationOperationRecord,
  type AllocationTransition,
} from '../record.ts';
import { applyAllocationTransition } from '../transitions.ts';
import {
  ALLOCATION_GRANTED_STATUS,
  ALLOCATION_LEASE,
  ALLOCATION_PENDING_STATUS,
  ALLOCATION_REFUSED_STATUS,
  ALLOCATION_REQUEST,
} from './fixtures.ts';

const NOW = 1_700_000_000_000;

function requested(overrides: Partial<Parameters<typeof newAllocationOperation>[0]> = {}) {
  return newAllocationOperation({
    ...ALLOCATION_REQUEST,
    allocatorInstanceId: 'allocator-1',
    nowMs: NOW,
    ...overrides,
  });
}

function apply(
  record: AllocationOperationRecord,
  transition: AllocationTransition,
  nowMs = NOW + 1,
): AllocationOperationRecord {
  const result = applyAllocationTransition(record, transition, nowMs);
  assert.equal(result.status, 'applied');
  return result.record;
}

test('records a grant before binding publication and derives its managed binding fence', () => {
  const dispatched = apply(requested(), { kind: 'request-dispatched' });
  const granted = apply(dispatched, {
    kind: 'allocator-outcome',
    outcome: {
      status: 'granted',
      lease: ALLOCATION_LEASE,
      identityIncarnationId: 'incarnation-1',
    },
  });

  assert.equal(granted.phase.status, 'granted');
  assert.equal(granted.binding, 'unpublished');
  assert.equal(granted.release, 'not-requested');
  assert.deepEqual(
    bindingFenceFor(granted),
    managedBindingFence({
      requesterId: 'requester-a',
      requestGeneration: 1,
      identityIncarnationId: 'incarnation-1',
    }),
  );
  assert.notEqual(granted.fence.generation, dispatched.fence.generation);
});

test('exactly replaying a local transition is idempotent while a stale fence is refused by the store seam', () => {
  const dispatched = apply(requested(), { kind: 'request-dispatched' });
  const replay = applyAllocationTransition(dispatched, { kind: 'request-dispatched' }, NOW + 2);
  assert.equal(replay.status, 'already-applied');
  assert.equal(replay.record, dispatched);

  const granted = apply(dispatched, {
    kind: 'allocator-outcome',
    outcome: {
      status: 'granted',
      lease: ALLOCATION_LEASE,
      identityIncarnationId: 'incarnation-1',
    },
  });
  assert.throws(
    () => applyAllocationTransition(dispatched, { kind: 'binding-published' }, NOW + 3),
    (error: unknown) => error instanceof AppError && error.details?.reason === 'transition-invalid',
  );
  assert.throws(
    () => applyAllocationTransition(granted, { kind: 'binding-published' }, NOW + 3),
    (error: unknown) => error instanceof AppError && error.details?.reason === 'transition-invalid',
  );
  const publishPending = apply(granted, { kind: 'binding-publish-pending' });
  const published = apply(publishPending, { kind: 'binding-published' });
  assert.equal(
    applyAllocationTransition(published, { kind: 'binding-published' }, NOW + 4).status,
    'already-applied',
  );
});

test('cleanup and allocator release are ordered and remain retryable', () => {
  const granted = apply(apply(requested(), { kind: 'request-dispatched' }), {
    kind: 'allocator-outcome',
    outcome: {
      status: 'granted',
      lease: ALLOCATION_LEASE,
      identityIncarnationId: 'incarnation-1',
    },
  });
  const publishPending = apply(granted, { kind: 'binding-publish-pending' });
  const published = apply(publishPending, { kind: 'binding-published' });
  const pendingCleanup = apply(published, {
    kind: 'binding-cleanup-pending',
    message: 'binding teardown was not confirmed',
  });
  const cleaned = apply(pendingCleanup, { kind: 'binding-cleaned' });
  const releasePending = apply(cleaned, { kind: 'release-pending' });
  const released = apply(releasePending, { kind: 'allocator-released' });

  assert.equal(released.binding, 'cleaned');
  assert.equal(released.release, 'released');
  assert.equal(released.phase.status, 'granted');
});

test('allocator status conversion preserves lookup results and refuses malformed grants', () => {
  const dispatched = apply(requested(), { kind: 'request-dispatched' });
  const pending = applyAllocationTransition(
    dispatched,
    {
      kind: 'allocator-status',
      status: { ...ALLOCATION_PENDING_STATUS, identityIncarnationId: 'incarnation-1' },
    },
    NOW + 2,
  );
  assert.equal(pending.status, 'applied');
  assert.equal(pending.record.phase.status, 'pending');
  assert.equal(pending.record.identityIncarnationId, 'incarnation-1');

  const identityPreserved = applyAllocationTransition(
    pending.record,
    { kind: 'allocator-status', status: ALLOCATION_PENDING_STATUS },
    NOW + 2,
  );
  assert.equal(identityPreserved.status, 'already-applied');
  assert.equal(identityPreserved.record.identityIncarnationId, 'incarnation-1');

  const refused = applyAllocationTransition(
    pending.record,
    {
      kind: 'allocator-status',
      status: ALLOCATION_REFUSED_STATUS,
    },
    NOW + 3,
  );
  assert.equal(refused.status, 'applied');
  assert.equal(refused.record.phase.status, 'refused');

  const malformed = applyAllocationTransition(
    dispatched,
    {
      kind: 'allocator-status',
      status: { ...ALLOCATION_GRANTED_STATUS, lease: undefined },
    },
    NOW + 4,
  );
  assert.equal(malformed.status, 'applied');
  assert.equal(malformed.record.phase.status, 'ambiguous');

  const unknownWithGrant = applyAllocationTransition(
    dispatched,
    {
      kind: 'allocator-status',
      status: { ...ALLOCATION_GRANTED_STATUS, state: 'unknown' },
    },
    NOW + 5,
  );
  assert.equal(unknownWithGrant.status, 'applied');
  assert.equal(unknownWithGrant.record.phase.status, 'ambiguous');

  const unknownState = applyAllocationTransition(
    dispatched,
    {
      kind: 'allocator-status',
      status: { ...ALLOCATION_PENDING_STATUS, state: 'future' } as unknown as LeaseRequestStatus,
    },
    NOW + 6,
  );
  assert.equal(unknownState.status, 'applied');
  assert.equal(unknownState.record.phase.status, 'ambiguous');
});

test('record decoding fails closed for unsupported, ambiguous, and unfenced state', () => {
  const granted = apply(apply(requested(), { kind: 'request-dispatched' }), {
    kind: 'allocator-outcome',
    outcome: {
      status: 'granted',
      lease: ALLOCATION_LEASE,
      identityIncarnationId: 'incarnation-1',
    },
  });
  const stored = JSON.parse(JSON.stringify(granted)) as Record<string, unknown>;

  assert.deepEqual(decodeAllocationOperationRecord(stored), {
    status: 'decoded',
    record: granted,
  });
  assert.equal(
    unreadableReason(
      decodeAllocationOperationRecord({
        ...stored,
        schemaVersion: ALLOCATION_OPERATION_SCHEMA_VERSION + 1,
      }),
    ),
    'unsupported-version',
  );
  assert.equal(
    unreadableReason(
      decodeAllocationOperationRecord({
        ...stored,
        phase: { status: 'pending' },
        binding: 'published',
      }),
    ),
    'ambiguous',
  );
  assert.equal(
    unreadableReason(
      decodeAllocationOperationRecord({
        ...stored,
        phase: { status: 'refused', refusal: { reason: 'simulator-capacity' } },
        binding: 'unpublished',
      }),
    ),
    'ambiguous',
  );
  assert.equal(
    unreadableReason(
      decodeAllocationOperationRecord({
        ...stored,
        fence: { token: 'not-canonical', generation: 2 },
      }),
    ),
    'unfenced',
  );
});

test('an ambiguous transition is a fail-closed terminal fence', () => {
  const dispatched = apply(requested(), { kind: 'request-dispatched' });
  const ambiguous = applyAllocationTransition(
    dispatched,
    {
      kind: 'allocator-status',
      status: { ...ALLOCATION_GRANTED_STATUS, lease: undefined },
    },
    NOW + 2,
  );
  assert.equal(ambiguous.status, 'applied');
  assert.equal(ambiguous.record.phase.status, 'ambiguous');
  const replay = applyAllocationTransition(
    ambiguous.record,
    {
      kind: 'allocator-outcome',
      outcome: {
        status: 'granted',
        lease: ALLOCATION_GRANTED_STATUS.lease!,
        identityIncarnationId: 'incarnation-1',
      },
    },
    NOW + 3,
  );
  assert.equal(replay.status, 'already-terminal');
  assert.equal(replay.record, ambiguous.record);
});

function unreadableReason(
  result: ReturnType<typeof decodeAllocationOperationRecord>,
): string | undefined {
  return result.status === 'unreadable' ? result.reason : undefined;
}
