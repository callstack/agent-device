import type { JsonObject } from '@agent-device/contracts/client';
import type {
  LeaseRequestStatus,
  LeaseRefusal,
  ManagedLease,
  ManagedShapeRequest,
} from '@agent-device/contracts/managed-device-allocation';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';
import type { ALLOCATION_OPERATION_SCHEMA_VERSION } from './schema.ts';

export type AllocationOperationRef = Readonly<{
  requesterId: string;
  attemptKey: string;
}>;

export type AllocationOperationBinding =
  | 'unpublished'
  | 'publish-pending'
  | 'published'
  | 'cleanup-pending'
  | 'cleaned'
  | 'not-applicable';

export type AllocationOperationRelease = 'not-requested' | 'pending' | 'released';

export type AllocationOperationPhase =
  | Readonly<{ status: 'unresolved' }>
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'unknown'; message: string }>
  | Readonly<{ status: 'ambiguous'; message: string }>
  | Readonly<{ status: 'granted'; lease: ManagedLease }>
  | Readonly<{ status: 'refused'; refusal: LeaseRefusal }>
  | Readonly<{ status: 'superseded' }>
  | Readonly<{ status: 'cancelled' }>;

export type AllocationOperationRecord = Readonly<{
  schemaVersion: typeof ALLOCATION_OPERATION_SCHEMA_VERSION;
  requesterId: string;
  attemptKey: string;
  allocatorInstanceId: string;
  shape: ManagedShapeRequest;
  deadlineAtMs: number;
  requestGeneration: number;
  admission: 'fail-fast';
  activation: 'direct' | 'external-fence';
  attribution?: JsonObject;
  identityIncarnationId?: string;
  createdAtMs: number;
  updatedAtMs: number;
  fence: ResourceOwnershipFence;
  phase: AllocationOperationPhase;
  binding: AllocationOperationBinding;
  release: AllocationOperationRelease;
}>;

export type NewAllocationOperationInput = Readonly<
  Omit<
    AllocationOperationRecord,
    'schemaVersion' | 'createdAtMs' | 'updatedAtMs' | 'fence' | 'phase' | 'binding' | 'release'
  > & {
    nowMs: number;
  }
>;

export type AllocationAllocatorOutcome =
  | Readonly<{ status: 'pending'; identityIncarnationId?: string }>
  | Readonly<{
      status: 'granted';
      lease: ManagedLease;
      identityIncarnationId: string;
    }>
  | Readonly<{ status: 'refused'; refusal: LeaseRefusal; identityIncarnationId?: string }>
  | Readonly<{ status: 'superseded' }>
  | Readonly<{ status: 'cancelled' }>;

export type AllocationTransition =
  | Readonly<{ kind: 'request-dispatched' }>
  | Readonly<{ kind: 'allocator-outcome'; outcome: AllocationAllocatorOutcome }>
  | Readonly<{ kind: 'allocator-status'; status: LeaseRequestStatus }>
  | Readonly<{ kind: 'allocator-unknown'; message: string }>
  | Readonly<{ kind: 'allocator-ambiguous'; message: string }>
  | Readonly<{ kind: 'binding-publish-pending' }>
  | Readonly<{ kind: 'binding-published' }>
  | Readonly<{ kind: 'binding-cleanup-pending'; message?: string }>
  | Readonly<{ kind: 'binding-cleaned' }>
  | Readonly<{ kind: 'release-pending' }>
  | Readonly<{ kind: 'allocator-released' }>;

export type AllocationTransitionResult =
  | Readonly<{ status: 'applied'; record: AllocationOperationRecord }>
  | Readonly<{ status: 'already-applied'; record: AllocationOperationRecord }>
  | Readonly<{ status: 'already-terminal'; record: AllocationOperationRecord }>;
