import type { LeaseRequestStatus } from '@agent-device/contracts/managed-device-allocation';
import { isRequestGeneration, isVerbatimId } from './allocation-operation-record-validation.ts';
import type {
  AllocationOperationRecord,
  AllocationTransition,
} from './allocation-operation-record.ts';

type TerminalLeaseRequestStatus = LeaseRequestStatus &
  Readonly<{ state: 'superseded' | 'cancelled' }>;

export function transitionFromAllocatorStatus(
  record: AllocationOperationRecord,
  status: LeaseRequestStatus,
): AllocationTransition {
  if (!matchesOperation(record, status)) {
    return {
      kind: 'allocator-ambiguous',
      message: 'allocator status does not identify this operation',
    };
  }
  if (status.identityIncarnationId !== undefined && !isVerbatimId(status.identityIncarnationId)) {
    return {
      kind: 'allocator-ambiguous',
      message: 'allocator status has an invalid identity incarnation',
    };
  }
  return transitionForKnownStatus(status);
}

function matchesOperation(record: AllocationOperationRecord, status: LeaseRequestStatus): boolean {
  return (
    isVerbatimId(status.requesterId) &&
    isVerbatimId(status.attemptKey) &&
    status.requesterId === record.requesterId &&
    status.attemptKey === record.attemptKey &&
    isRequestGeneration(status.requestGeneration) &&
    status.requestGeneration === record.requestGeneration
  );
}

function transitionForKnownStatus(status: LeaseRequestStatus): AllocationTransition {
  switch (status.state) {
    case 'unknown':
      return transitionForUnknown(status);
    case 'pending':
      return transitionForPending(status);
    case 'granted':
      return transitionForGranted(status);
    case 'refused':
      return transitionForRefused(status);
    case 'superseded':
    case 'cancelled':
      return transitionForTerminal(status as TerminalLeaseRequestStatus);
    default:
      return { kind: 'allocator-ambiguous', message: 'allocator status has an unknown state' };
  }
}

function transitionForUnknown(status: LeaseRequestStatus): AllocationTransition {
  return hasTerminalData(status)
    ? { kind: 'allocator-ambiguous', message: 'allocator unknown status carried terminal data' }
    : { kind: 'allocator-unknown', message: 'allocator status is unknown' };
}

function transitionForPending(status: LeaseRequestStatus): AllocationTransition {
  if (hasTerminalData(status)) {
    return {
      kind: 'allocator-ambiguous',
      message: 'allocator pending status carried terminal data',
    };
  }
  return {
    kind: 'allocator-outcome',
    outcome: {
      status: 'pending',
      ...(status.identityIncarnationId === undefined
        ? {}
        : { identityIncarnationId: status.identityIncarnationId }),
    },
  };
}

function transitionForGranted(status: LeaseRequestStatus): AllocationTransition {
  if (
    status.lease === undefined ||
    status.identityIncarnationId === undefined ||
    status.refusal !== undefined
  ) {
    return {
      kind: 'allocator-ambiguous',
      message: 'allocator grant omitted its lease or identity incarnation',
    };
  }
  return {
    kind: 'allocator-outcome',
    outcome: {
      status: 'granted',
      lease: status.lease,
      identityIncarnationId: status.identityIncarnationId,
    },
  };
}

function transitionForRefused(status: LeaseRequestStatus): AllocationTransition {
  if (status.refusal === undefined || status.lease !== undefined) {
    return {
      kind: 'allocator-ambiguous',
      message: 'allocator refusal carried incomplete or conflicting data',
    };
  }
  return {
    kind: 'allocator-outcome',
    outcome: {
      status: 'refused',
      refusal: status.refusal,
      ...(status.identityIncarnationId === undefined
        ? {}
        : { identityIncarnationId: status.identityIncarnationId }),
    },
  };
}

function transitionForTerminal(status: TerminalLeaseRequestStatus): AllocationTransition {
  return hasTerminalData(status)
    ? { kind: 'allocator-ambiguous', message: 'allocator terminal status carried conflicting data' }
    : { kind: 'allocator-outcome', outcome: { status: status.state } };
}

function hasTerminalData(status: LeaseRequestStatus): boolean {
  return status.lease !== undefined || status.refusal !== undefined;
}
