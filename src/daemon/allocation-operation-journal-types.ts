import type {
  LeaseRequestInput,
  SupersedeLeaseRequestInput,
} from '@agent-device/contracts/managed-device-allocation';
import type {
  AllocationAction,
  AllocationBinding,
  AllocationDecisionMode,
} from './allocation-operation-decision.ts';
import type { AllocationOperationRecord } from './allocation-operation-record.ts';
import type { AllocationOperationUnreadable } from './allocation-operation-store.ts';

export type AllocationBindingHooks = Readonly<{
  publish(binding: AllocationBinding): Promise<void>;
  cleanup(binding: AllocationBinding): Promise<void>;
}>;

export type AllocationJournalBlockReason =
  | 'ambiguous-state'
  | 'already-granted'
  | 'binding-unavailable'
  | 'fence-lost'
  | 'invalid-transition'
  | 'operation-missing'
  | 'payload-mismatch'
  | 'persistence-failed'
  | 'lane-busy'
  | 'not-releasable';

export type AllocationJournalReason =
  | 'allocator-uncertain'
  | 'cleanup-uncertain'
  | 'release-uncertain';

export type AllocationJournalResult =
  | Readonly<{
      status:
        | 'pending'
        | 'abandoned'
        | 'uncertain'
        | 'granted'
        | 'refused'
        | 'superseded'
        | 'cancelled'
        | 'cleanup-pending'
        | 'released';
      record: AllocationOperationRecord;
      reason?: AllocationJournalReason;
      message?: string;
    }>
  | Readonly<{
      status: 'blocked';
      record?: AllocationOperationRecord;
      reason: AllocationJournalBlockReason;
      message: string;
    }>
  | Readonly<{
      status: 'unreadable';
      path: string;
      reason: AllocationOperationUnreadable['reason'];
      message: string;
      version?: number;
    }>;

export type JournalContext = Readonly<{
  signal?: AbortSignal;
  requestInput?: LeaseRequestInput;
  supersedeInput?: SupersedeLeaseRequestInput;
}>;

export type PersistedTransition =
  | Readonly<{ status: 'stored'; record: AllocationOperationRecord }>
  | AllocationJournalResult;

export type AllocationJournalActionRunner = Readonly<{
  request(
    record: AllocationOperationRecord,
    context: JournalContext,
  ): Promise<AllocationJournalResult>;
  supersede(
    record: AllocationOperationRecord,
    context: JournalContext,
  ): Promise<AllocationJournalResult>;
  lookup(
    record: AllocationOperationRecord,
    mode: AllocationDecisionMode,
    signal?: AbortSignal,
  ): Promise<AllocationJournalResult>;
  cancel(record: AllocationOperationRecord): Promise<AllocationJournalResult>;
  publish(
    record: AllocationOperationRecord,
    action: Extract<AllocationAction, { kind: 'publish' }>,
    signal?: AbortSignal,
  ): Promise<AllocationJournalResult>;
  cleanup(
    record: AllocationOperationRecord,
    action: Extract<AllocationAction, { kind: 'cleanup' }>,
  ): Promise<AllocationJournalResult>;
  release(record: AllocationOperationRecord): Promise<AllocationJournalResult>;
}>;
