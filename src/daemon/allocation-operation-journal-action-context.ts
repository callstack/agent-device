import type { ManagedDeviceAllocatorPort } from '@agent-device/contracts/managed-device-allocation';
import type { AllocationDecisionMode } from './allocation-operation-decision.ts';
import type { AllocationOperationRecord } from './allocation-operation-record.ts';
import type {
  AllocationBindingHooks,
  AllocationJournalResult,
  JournalContext,
} from './allocation-operation-journal-types.ts';
import type { AllocationOperationStore } from './allocation-operation-store.ts';

export type AllocationActionRunnerContext = Readonly<{
  allocator: ManagedDeviceAllocatorPort;
  binding?: AllocationBindingHooks;
  store: AllocationOperationStore;
  now: () => number;
  execute(
    record: AllocationOperationRecord,
    mode: AllocationDecisionMode,
    context: JournalContext,
  ): Promise<AllocationJournalResult>;
  project(record: AllocationOperationRecord): AllocationJournalResult;
}>;
