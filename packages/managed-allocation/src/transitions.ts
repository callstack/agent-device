import { isFiniteNumber } from './record-validation.ts';
import { transitionFromAllocatorStatus } from './status.ts';
import { applyAllocatorOutcome } from './transition-outcome.ts';

// Public transition surface for the managed runtime binding (ADR 0021 §3), which lands after
// this move, so fallow sees no importer of the re-export yet.
// fallow-ignore-next-line unused-export
export { applyAllocatorOutcome };
import {
  alreadyApplied,
  applied,
  isTransitionTerminal,
  terminalOrInvalid,
  transitionInvalid,
} from './transition-support.ts';
import type {
  AllocationOperationRecord,
  AllocationTransition,
  AllocationTransitionResult,
} from './record.ts';

export function applyAllocationTransition(
  record: AllocationOperationRecord,
  transition: AllocationTransition,
  nowMs: number,
): AllocationTransitionResult {
  if (!isFiniteNumber(nowMs)) throw new TypeError('Allocation transition time must be finite');
  const resolved =
    transition.kind === 'allocator-status'
      ? transitionFromAllocatorStatus(record, transition.status)
      : transition;
  if (resolved.kind === 'allocator-status')
    throw new TypeError('Allocator status was not normalized');
  return applyResolvedTransition(record, resolved, nowMs);
}

type ResolvedAllocationTransition = Exclude<AllocationTransition, { kind: 'allocator-status' }>;

function applyResolvedTransition(
  record: AllocationOperationRecord,
  resolved: ResolvedAllocationTransition,
  nowMs: number,
): AllocationTransitionResult {
  if (resolved.kind === 'request-dispatched') return applyRequestDispatch(record, nowMs);
  if (resolved.kind === 'allocator-outcome') {
    return applyAllocatorOutcome(record, resolved.outcome, nowMs);
  }
  if (isAllocatorUncertaintyTransition(resolved)) {
    return applyAllocatorUncertainty(record, resolved, nowMs);
  }
  if (isBindingTransition(resolved)) {
    return applyBindingTransition(record, resolved, nowMs);
  }
  if (isReleaseTransition(resolved)) {
    return applyReleaseTransition(record, resolved, nowMs);
  }
  return transitionInvalid('unknown', 'unsupported transition');
}

function isAllocatorUncertaintyTransition(
  transition: ResolvedAllocationTransition,
): transition is Extract<
  ResolvedAllocationTransition,
  { kind: 'allocator-unknown' | 'allocator-ambiguous' }
> {
  return transition.kind === 'allocator-unknown' || transition.kind === 'allocator-ambiguous';
}

function isBindingTransition(transition: ResolvedAllocationTransition): transition is Extract<
  ResolvedAllocationTransition,
  {
    kind:
      | 'binding-publish-pending'
      | 'binding-published'
      | 'binding-cleanup-pending'
      | 'binding-cleaned';
  }
> {
  return (
    transition.kind === 'binding-publish-pending' ||
    transition.kind === 'binding-published' ||
    transition.kind === 'binding-cleanup-pending' ||
    transition.kind === 'binding-cleaned'
  );
}

function isReleaseTransition(
  transition: ResolvedAllocationTransition,
): transition is Extract<
  ResolvedAllocationTransition,
  { kind: 'release-pending' | 'allocator-released' }
> {
  return transition.kind === 'release-pending' || transition.kind === 'allocator-released';
}

function applyRequestDispatch(
  record: AllocationOperationRecord,
  nowMs: number,
): AllocationTransitionResult {
  if (record.phase.status === 'unresolved') {
    return applied(record, { phase: { status: 'pending' } }, nowMs);
  }
  if (record.phase.status === 'pending' || record.phase.status === 'unknown') {
    return alreadyApplied(record);
  }
  return terminalOrInvalid(record, 'request-dispatched');
}

function applyAllocatorUncertainty(
  record: AllocationOperationRecord,
  transition: Extract<
    ResolvedAllocationTransition,
    { kind: 'allocator-unknown' | 'allocator-ambiguous' }
  >,
  nowMs: number,
): AllocationTransitionResult {
  if (isTransitionTerminal(record.phase)) return terminalOrInvalid(record, transition.kind);
  const status = transition.kind === 'allocator-unknown' ? 'unknown' : 'ambiguous';
  if (record.phase.status === status && record.phase.message === transition.message) {
    return alreadyApplied(record);
  }
  return applied(record, { phase: { status, message: transition.message } }, nowMs);
}

function applyBindingTransition(
  record: AllocationOperationRecord,
  transition: Extract<
    ResolvedAllocationTransition,
    {
      kind:
        | 'binding-publish-pending'
        | 'binding-published'
        | 'binding-cleanup-pending'
        | 'binding-cleaned';
    }
  >,
  nowMs: number,
): AllocationTransitionResult {
  if (record.phase.status !== 'granted') return terminalOrInvalid(record, transition.kind);
  if (transition.kind === 'binding-publish-pending') {
    return applyPublishPendingBinding(record, nowMs);
  }
  if (transition.kind === 'binding-published') return applyPublishedBinding(record, nowMs);
  if (transition.kind === 'binding-cleaned') return applyCleanedBinding(record, nowMs);
  return applyCleanupPendingBinding(record, nowMs);
}

function applyPublishPendingBinding(
  record: AllocationOperationRecord,
  nowMs: number,
): AllocationTransitionResult {
  if (record.binding === 'publish-pending') return alreadyApplied(record);
  if (record.binding !== 'unpublished' || record.release !== 'not-requested') {
    return transitionInvalid('binding-publish-pending', record.binding);
  }
  return applied(record, { binding: 'publish-pending' }, nowMs);
}

function applyPublishedBinding(
  record: AllocationOperationRecord,
  nowMs: number,
): AllocationTransitionResult {
  if (record.binding === 'published') return alreadyApplied(record);
  if (record.binding !== 'publish-pending')
    return transitionInvalid('binding-published', record.binding);
  return applied(record, { binding: 'published' }, nowMs);
}

function applyCleanupPendingBinding(
  record: AllocationOperationRecord,
  nowMs: number,
): AllocationTransitionResult {
  if (record.binding === 'cleanup-pending' && record.release === 'not-requested') {
    return alreadyApplied(record);
  }
  if (record.binding === 'cleaned' || record.release !== 'not-requested') {
    return transitionInvalid('binding-cleanup-pending', record.binding);
  }
  if (record.binding !== 'publish-pending' && record.binding !== 'published') {
    return transitionInvalid('binding-cleanup-pending', record.binding);
  }
  return applied(record, { binding: 'cleanup-pending' }, nowMs);
}

function applyCleanedBinding(
  record: AllocationOperationRecord,
  nowMs: number,
): AllocationTransitionResult {
  if (record.binding === 'cleaned') return alreadyApplied(record);
  if (
    !['unpublished', 'publish-pending', 'published', 'cleanup-pending'].includes(record.binding)
  ) {
    return transitionInvalid('binding-cleaned', record.binding);
  }
  return applied(record, { binding: 'cleaned' }, nowMs);
}

function applyReleaseTransition(
  record: AllocationOperationRecord,
  transition: Extract<
    ResolvedAllocationTransition,
    { kind: 'release-pending' | 'allocator-released' }
  >,
  nowMs: number,
): AllocationTransitionResult {
  if (record.phase.status !== 'granted') return terminalOrInvalid(record, transition.kind);
  if (transition.kind === 'release-pending') {
    if (record.release === 'pending' || record.release === 'released')
      return alreadyApplied(record);
    if (record.binding !== 'cleaned') return transitionInvalid('release-pending', record.binding);
    return applied(record, { release: 'pending' }, nowMs);
  }
  if (record.release === 'released') return alreadyApplied(record);
  if (record.release !== 'pending' || record.binding !== 'cleaned') {
    return transitionInvalid('allocator-released', record.release);
  }
  return applied(record, { release: 'released' }, nowMs);
}
