import type { ManagedDeviceAllocatorPort } from '@agent-device/contracts/managed-device-allocation';
import type { AllocationDecisionMode } from './decision.ts';
import type { AllocationOperationRecord } from './record.ts';
import type {
  AllocationBindingHooks,
  AllocationJournalResult,
  JournalContext,
} from './journal-types.ts';
import type { AllocationOperationStore } from './store.ts';

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
