import { AppError } from '@agent-device/kernel/errors';
import { allocationOperationFence } from './allocation-operation-fence.ts';
import type {
  AllocationOperationPhase,
  AllocationOperationRecord,
  AllocationTransitionResult,
} from './allocation-operation-record.ts';

export function applied(
  record: AllocationOperationRecord,
  updates: Partial<
    Pick<AllocationOperationRecord, 'phase' | 'binding' | 'release' | 'identityIncarnationId'>
  >,
  nowMs: number,
): AllocationTransitionResult {
  const phase = updates.phase === undefined ? record.phase : Object.freeze(updates.phase);
  return {
    status: 'applied',
    record: Object.freeze({
      ...record,
      ...updates,
      phase,
      updatedAtMs: nowMs,
      fence: allocationOperationFence(record, record.fence.generation + 1),
    }),
  };
}

export function alreadyApplied(record: AllocationOperationRecord): AllocationTransitionResult {
  return { status: 'already-applied', record };
}

export function terminalOrInvalid(
  record: AllocationOperationRecord,
  transition: string,
): AllocationTransitionResult {
  return isTransitionTerminal(record.phase)
    ? { status: 'already-terminal', record }
    : transitionInvalid(transition, record.phase.status);
}

export function ambiguous(
  record: AllocationOperationRecord,
  message: string,
  nowMs: number,
): AllocationTransitionResult {
  return applied(record, { phase: { status: 'ambiguous', message } }, nowMs);
}

export function transitionInvalid(transition: string, state: unknown): never {
  throw allocationError(
    'transition-invalid',
    `Allocation transition '${transition}' is invalid from ${String(state)}`,
  );
}

export function isTransitionTerminal(phase: AllocationOperationPhase): boolean {
  return ['granted', 'refused', 'superseded', 'cancelled', 'ambiguous'].includes(phase.status);
}

function allocationError(reason: string, message: string): AppError {
  return new AppError('COMMAND_FAILED', message, { reason, retriable: false });
}
