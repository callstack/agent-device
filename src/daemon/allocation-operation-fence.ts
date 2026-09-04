import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';
import type { AllocationOperationRef } from './allocation-operation-record.ts';
import { isFenceGeneration, isVerbatimId } from './allocation-operation-record-validation.ts';

export function allocationOperationFence(
  ref: AllocationOperationRef,
  generation: number,
): ResourceOwnershipFence {
  if (
    !isVerbatimId(ref.requesterId) ||
    !isVerbatimId(ref.attemptKey) ||
    !isFenceGeneration(generation)
  ) {
    throw new TypeError(
      'Allocation operation fence requires canonical ids and a non-negative generation',
    );
  }
  return Object.freeze({
    token: JSON.stringify([ref.requesterId, ref.attemptKey]),
    generation,
  });
}
