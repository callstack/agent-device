import { ALLOCATION_OPERATION_SCHEMA_VERSION } from './schema.ts';

export { ALLOCATION_OPERATION_SCHEMA_VERSION };
export { newAllocationOperation } from './record-factory.ts';
export { decodeAllocationOperationRecord } from './record-codec.ts';
export { bindingFenceFor } from './record-fence.ts';
export type {
  AllocationAllocatorOutcome,
  AllocationOperationPhase,
  AllocationOperationRecord,
  AllocationOperationRef,
  AllocationTransition,
  AllocationTransitionResult,
} from './record-types.ts';
// These record-model names round out the package's public record surface: the managed runtime
// binding (ADR 0021 §3) consumes them, and it lands after this move, so fallow sees no importer
// yet. Suppressed per name rather than baselined so the reason travels with the code.
// fallow-ignore-next-line unused-type
export type { AllocationOperationBinding } from './record-types.ts';
// fallow-ignore-next-line unused-type
export type { AllocationOperationRelease } from './record-types.ts';
// fallow-ignore-next-line unused-type
export type { NewAllocationOperationInput } from './record-types.ts';
