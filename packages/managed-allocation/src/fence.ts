import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';
import type { AllocationOperationRef } from './record-types.ts';
import { isFenceGeneration, isVerbatimId } from './record-validation.ts';

/** The one string identity of an attempt: its fence token and every in-memory index of it. */
export function allocationOperationKey(ref: AllocationOperationRef): string {
  return JSON.stringify([ref.requesterId, ref.attemptKey]);
}

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
    token: allocationOperationKey(ref),
    generation,
  });
}
