import { AppError } from '@agent-device/kernel/errors';
import { freezeJsonObject } from '@agent-device/capture-kit';
import { allocationOperationFence } from './fence.ts';
import { ALLOCATION_OPERATION_SCHEMA_VERSION } from './schema.ts';
import { isAllocationRequest } from './record-validation.ts';
import type { AllocationOperationRecord, NewAllocationOperationInput } from './record.ts';

export function newAllocationOperation(
  fields: NewAllocationOperationInput,
): AllocationOperationRecord {
  if (!isAllocationRequest(fields)) {
    throw new AppError('COMMAND_FAILED', 'Allocation operation request is invalid', {
      reason: 'allocation-request-invalid',
      retriable: false,
    });
  }
  return Object.freeze({
    schemaVersion: ALLOCATION_OPERATION_SCHEMA_VERSION,
    requesterId: fields.requesterId,
    attemptKey: fields.attemptKey,
    allocatorInstanceId: fields.allocatorInstanceId,
    shape: Object.freeze({ ...fields.shape }),
    deadlineAtMs: fields.deadlineAtMs,
    requestGeneration: fields.requestGeneration,
    admission: fields.admission,
    activation: fields.activation,
    ...(fields.attribution === undefined
      ? {}
      : { attribution: freezeJsonObject(fields.attribution) }),
    createdAtMs: fields.nowMs,
    updatedAtMs: fields.nowMs,
    fence: allocationOperationFence(fields, 0),
    phase: Object.freeze({ status: 'unresolved' as const }),
    binding: 'unpublished',
    release: 'not-requested',
  });
}
