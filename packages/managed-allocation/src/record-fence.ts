import {
  managedBindingFence,
  type ResourceOwnershipFence,
} from '@agent-device/contracts/platform-runtime';
import type { AllocationOperationRecord } from './record-types.ts';

export function bindingFenceFor(record: AllocationOperationRecord): ResourceOwnershipFence | null {
  if (record.phase.status !== 'granted' || record.identityIncarnationId === undefined) return null;
  return managedBindingFence({
    requesterId: record.requesterId,
    requestGeneration: record.requestGeneration,
    identityIncarnationId: record.identityIncarnationId,
  });
}
