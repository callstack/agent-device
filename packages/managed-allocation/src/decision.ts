import type {
  LeaseRequestRef,
  ManagedLease,
} from '@agent-device/contracts/managed-device-allocation';
import type { AllocationOperationRecord, AllocationOperationRef } from './record.ts';
import { bindingFenceFor } from './record-fence.ts';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';

export type AllocationDecisionMode =
  | 'new'
  | 'recover'
  | 'continue'
  | 'cancel'
  | 'release'
  | 'supersede';

export type AllocationBinding = Readonly<{
  operation: AllocationOperationRef;
  identityIncarnationId: string;
  lease: ManagedLease;
  fence: ResourceOwnershipFence;
}>;

export type AllocationAction =
  | Readonly<{ kind: 'request'; ref: LeaseRequestRef }>
  | Readonly<{ kind: 'supersede'; ref: LeaseRequestRef }>
  | Readonly<{ kind: 'lookup'; ref: LeaseRequestRef }>
  | Readonly<{ kind: 'cancel'; ref: LeaseRequestRef }>
  | Readonly<{ kind: 'publish'; binding: AllocationBinding }>
  | Readonly<{ kind: 'cleanup'; binding: AllocationBinding }>
  | Readonly<{ kind: 'release'; leaseId: string }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'terminal' }>
  | Readonly<{
      kind: 'blocked';
      reason: 'ambiguous-state' | 'already-granted' | 'binding-unavailable' | 'not-releasable';
      message: string;
    }>;

export function decideAllocationAction(
  record: AllocationOperationRecord,
  mode: AllocationDecisionMode,
): AllocationAction {
  const ref = { requesterId: record.requesterId, attemptKey: record.attemptKey };

  if (record.phase.status === 'ambiguous') {
    return blocked('ambiguous-state', 'allocation operation state is ambiguous');
  }
  if (record.phase.status === 'granted') {
    return decideGrantedAction(record, mode);
  }
  if (
    record.phase.status === 'refused' ||
    record.phase.status === 'superseded' ||
    record.phase.status === 'cancelled'
  ) {
    return { kind: 'terminal' };
  }
  if (mode === 'cancel') return { kind: 'cancel', ref };
  if (mode === 'new' && record.phase.status === 'unresolved') return { kind: 'request', ref };
  if (mode === 'supersede' && record.phase.status === 'unresolved')
    return { kind: 'supersede', ref };
  if (record.phase.status === 'unknown') return { kind: 'lookup', ref };
  if (record.phase.status === 'pending') {
    return mode === 'continue' ? { kind: 'pending' } : { kind: 'lookup', ref };
  }
  return { kind: 'lookup', ref };
}

function decideGrantedAction(
  record: AllocationOperationRecord,
  mode: AllocationDecisionMode,
): AllocationAction {
  if (record.phase.status !== 'granted') {
    return blocked('ambiguous-state', 'granted action received a non-granted record');
  }
  const binding = toBinding(record);
  if (!binding) return blocked('ambiguous-state', 'granted allocation has no binding identity');
  if (mode === 'cancel') return blocked('already-granted', 'allocation is already granted');
  const cleanup = decideGrantedCleanup(record, mode, binding);
  if (cleanup) return cleanup;
  const leaseId = record.phase.lease.id;
  if (mode === 'release') return decideGrantedRelease(record, leaseId);
  return decideGrantedBinding(record, binding, leaseId);
}

function decideGrantedCleanup(
  record: AllocationOperationRecord,
  mode: AllocationDecisionMode,
  binding: AllocationBinding,
): AllocationAction | undefined {
  const recoveryCleanup =
    mode === 'recover' &&
    (record.binding === 'publish-pending' || record.binding === 'cleanup-pending');
  if ((mode !== 'release' && !recoveryCleanup) || record.binding === 'cleaned') return undefined;
  return record.release === 'not-requested' ? { kind: 'cleanup', binding } : undefined;
}

function decideGrantedRelease(
  record: AllocationOperationRecord,
  leaseId: string,
): AllocationAction {
  return record.release === 'released' ? { kind: 'terminal' } : { kind: 'release', leaseId };
}

function decideGrantedBinding(
  record: AllocationOperationRecord,
  binding: AllocationBinding,
  leaseId: string,
): AllocationAction {
  if (record.binding === 'unpublished') return { kind: 'publish', binding };
  if (record.binding === 'published') return { kind: 'terminal' };
  if (record.binding === 'publish-pending') {
    return blocked(
      'not-releasable',
      'allocation binding publication is uncertain and requires explicit release recovery',
    );
  }
  if (record.binding === 'cleanup-pending') {
    return blocked('not-releasable', 'allocation binding requires explicit release recovery');
  }
  return record.release === 'released' ? { kind: 'terminal' } : { kind: 'release', leaseId };
}

function toBinding(record: AllocationOperationRecord): AllocationBinding | null {
  if (record.phase.status !== 'granted' || record.identityIncarnationId === undefined) return null;
  const fence = bindingFenceFor(record);
  if (!fence) return null;
  return Object.freeze({
    operation: Object.freeze({ requesterId: record.requesterId, attemptKey: record.attemptKey }),
    identityIncarnationId: record.identityIncarnationId,
    lease: record.phase.lease,
    fence,
  });
}

function blocked(
  reason: Extract<AllocationAction, { kind: 'blocked' }>['reason'],
  message: string,
): AllocationAction {
  return { kind: 'blocked', reason, message };
}
