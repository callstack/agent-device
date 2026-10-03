import { isDeepStrictEqual } from 'node:util';
import {
  freezeLease,
  freezeRefusal,
  isValidLease,
  isValidRefusal,
  isVerbatimId,
} from './record-validation.ts';
import type {
  AllocationAllocatorOutcome,
  AllocationOperationRecord,
  AllocationTransitionResult,
} from './record.ts';
import {
  alreadyApplied,
  ambiguous,
  applied,
  isTransitionTerminal,
  transitionInvalid,
} from './transition-support.ts';

export function applyAllocatorOutcome(
  record: AllocationOperationRecord,
  outcome: AllocationAllocatorOutcome,
  nowMs: number,
): AllocationTransitionResult {
  if (isTransitionTerminal(record.phase)) {
    if (record.phase.status !== 'ambiguous' && sameAllocatorOutcome(record, outcome)) {
      return alreadyApplied(record);
    }
    return { status: 'already-terminal', record };
  }
  const identity = outcomeIdentity(outcome);
  const validation = validateAllocatorOutcome(record, outcome, identity);
  if (validation) return ambiguous(record, validation, nowMs);
  if (isPendingReplay(record, outcome, identity)) return alreadyApplied(record);
  return applyKnownAllocatorOutcome(record, outcome, identity, nowMs);
}

function outcomeIdentity(outcome: AllocationAllocatorOutcome): string | undefined {
  return outcome.status === 'granted' ||
    outcome.status === 'pending' ||
    outcome.status === 'refused'
    ? outcome.identityIncarnationId
    : undefined;
}

function validateAllocatorOutcome(
  record: AllocationOperationRecord,
  outcome: AllocationAllocatorOutcome,
  identity: string | undefined,
): string | undefined {
  if (identity !== undefined && !isVerbatimId(identity)) {
    return 'allocator returned an invalid identity incarnation';
  }
  if (
    record.identityIncarnationId !== undefined &&
    identity !== undefined &&
    record.identityIncarnationId !== identity
  ) {
    return 'allocator changed the identity incarnation for one operation';
  }
  return validateAllocatorPayload(outcome);
}

function validateAllocatorPayload(outcome: AllocationAllocatorOutcome): string | undefined {
  if (outcome.status === 'granted') {
    return isVerbatimId(outcome.identityIncarnationId) && isValidLease(outcome.lease)
      ? undefined
      : 'allocator grant did not contain a valid lease and identity';
  }
  if (outcome.status === 'refused' && !isValidRefusal(outcome.refusal)) {
    return 'allocator refusal did not contain a valid refusal';
  }
  return undefined;
}

function isPendingReplay(
  record: AllocationOperationRecord,
  outcome: AllocationAllocatorOutcome,
  identity: string | undefined,
): boolean {
  return (
    outcome.status === 'pending' &&
    record.phase.status === 'pending' &&
    (identity === undefined || record.identityIncarnationId === identity)
  );
}

function applyKnownAllocatorOutcome(
  record: AllocationOperationRecord,
  outcome: AllocationAllocatorOutcome,
  identity: string | undefined,
  nowMs: number,
): AllocationTransitionResult {
  switch (outcome.status) {
    case 'pending':
      return applied(
        record,
        {
          phase: { status: 'pending' },
          ...(identity === undefined ? {} : { identityIncarnationId: identity }),
        },
        nowMs,
      );
    case 'granted':
      return applied(
        record,
        {
          phase: { status: 'granted', lease: freezeLease(outcome.lease) },
          identityIncarnationId: outcome.identityIncarnationId,
          binding: 'unpublished',
          release: 'not-requested',
        },
        nowMs,
      );
    case 'refused':
      return applied(
        record,
        {
          phase: { status: 'refused', refusal: freezeRefusal(outcome.refusal) },
          ...(identity === undefined ? {} : { identityIncarnationId: identity }),
          binding: 'not-applicable',
        },
        nowMs,
      );
    case 'superseded':
      return applied(record, { phase: { status: 'superseded' }, binding: 'not-applicable' }, nowMs);
    case 'cancelled':
      return applied(record, { phase: { status: 'cancelled' }, binding: 'not-applicable' }, nowMs);
    default:
      return transitionInvalid('allocator-outcome', 'unsupported outcome');
  }
}

function sameAllocatorOutcome(
  record: AllocationOperationRecord,
  outcome: AllocationAllocatorOutcome,
): boolean {
  if (outcome.status === 'granted')
    return (
      record.phase.status === 'granted' &&
      record.identityIncarnationId === outcome.identityIncarnationId &&
      isDeepStrictEqual(record.phase.lease, outcome.lease)
    );
  if (outcome.status === 'refused')
    return (
      record.phase.status === 'refused' && isDeepStrictEqual(record.phase.refusal, outcome.refusal)
    );
  return record.phase.status === outcome.status;
}
