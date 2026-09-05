import type {
  LeaseRefusal,
  ManagedLease,
  ManagedShapeRequest,
} from '@agent-device/contracts/managed-device-allocation';
import type { AllocationOperationPhase, AllocationOperationRecord } from './record.ts';
import {
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
  isVerbatimId,
} from './record-validation.ts';

export function decodePhase(value: unknown): AllocationOperationPhase | null {
  if (!isPlainObject(value)) return null;
  const simple = decodeSimplePhase(value.status);
  if (simple) return simple;
  if (value.status === 'unknown') return decodeMessagePhase('unknown', value.message);
  if (value.status === 'ambiguous') return decodeMessagePhase('ambiguous', value.message);
  if (value.status === 'granted') return decodeGrantedPhase(value.lease);
  if (value.status === 'refused') return decodeRefusedPhase(value.refusal);
  return null;
}

function decodeSimplePhase(value: unknown): AllocationOperationPhase | null {
  if (value === 'unresolved') return { status: 'unresolved' };
  if (value === 'pending') return { status: 'pending' };
  if (value === 'superseded') return { status: 'superseded' };
  if (value === 'cancelled') return { status: 'cancelled' };
  return null;
}

function decodeMessagePhase(
  status: 'unknown' | 'ambiguous',
  message: unknown,
): AllocationOperationPhase | null {
  return isNonEmptyString(message) ? { status, message } : null;
}

function decodeGrantedPhase(value: unknown): AllocationOperationPhase | null {
  const lease = decodeLease(value);
  return lease ? { status: 'granted', lease } : null;
}

function decodeRefusedPhase(value: unknown): AllocationOperationPhase | null {
  const refusal = decodeRefusal(value);
  return refusal ? { status: 'refused', refusal } : null;
}

type ConsistencyFields = {
  phase: AllocationOperationPhase;
  identityIncarnationId?: string;
  binding: AllocationOperationRecord['binding'];
  release: AllocationOperationRecord['release'];
};

export function checkConsistency(fields: ConsistencyFields): string | undefined {
  return fields.phase.status === 'granted'
    ? checkGrantedConsistency(fields)
    : checkNonGrantedConsistency(fields);
}

function checkGrantedConsistency(fields: ConsistencyFields): string | undefined {
  if (fields.identityIncarnationId === undefined) {
    return 'granted allocation record has no identity incarnation';
  }
  if (fields.binding === 'not-applicable') return 'granted allocation record has no binding state';
  if (
    (fields.binding === 'published' || fields.binding === 'cleanup-pending') &&
    fields.release !== 'not-requested'
  ) {
    return 'allocator release is recorded before binding cleanup';
  }
  if (fields.release !== 'not-requested' && fields.binding !== 'cleaned') {
    return 'allocator release is recorded before binding cleanup';
  }
  return undefined;
}

function checkNonGrantedConsistency(fields: ConsistencyFields): string | undefined {
  const expectedBinding = terminalPhase(fields.phase.status) ? 'not-applicable' : 'unpublished';
  if (fields.binding !== expectedBinding) return 'allocation record binding state is inconsistent';
  return fields.release === 'not-requested'
    ? undefined
    : 'non-granted allocation record claims allocator release';
}

function terminalPhase(
  status: AllocationOperationPhase['status'],
): status is 'refused' | 'superseded' | 'cancelled' {
  return status === 'refused' || status === 'superseded' || status === 'cancelled';
}

export function decodeShape(value: unknown): ManagedShapeRequest | null {
  if (!isPlainObject(value)) return null;
  if (value.platform !== 'ios' && value.platform !== 'android') return null;
  if (!isNonEmptyString(value.deviceType)) return null;
  if (value.osVersion !== undefined && !isNonEmptyString(value.osVersion)) return null;
  return Object.freeze({
    platform: value.platform,
    deviceType: value.deviceType,
    ...(value.osVersion === undefined ? {} : { osVersion: value.osVersion }),
  });
}

function decodeLease(value: unknown): ManagedLease | null {
  if (!isPlainObject(value)) return null;
  if (!isVerbatimId(value.id) || !isFiniteNumber(value.ttlDeadline)) return null;
  if (!isPlainObject(value.device) || !isVerbatimId(value.device.address)) return null;
  if (!isPlainObject(value.environment)) return null;
  if (Object.values(value.environment).some((item) => typeof item !== 'string')) return null;
  return Object.freeze({
    id: value.id,
    ttlDeadline: value.ttlDeadline,
    device: Object.freeze({ address: value.device.address }),
    environment: Object.freeze({ ...value.environment }) as Record<string, string>,
  });
}

function decodeRefusal(value: unknown): LeaseRefusal | null {
  if (!isPlainObject(value)) return null;
  if (
    ![
      'simulator-capacity',
      'disk-low',
      'invalid-shape',
      'preparation-required',
      'requester-busy',
    ].includes(String(value.reason))
  )
    return null;
  if (value.retryAfterMs !== undefined && !isFiniteNumber(value.retryAfterMs)) return null;
  if (value.message !== undefined && !isNonEmptyString(value.message)) return null;
  return Object.freeze({
    reason: value.reason,
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs: value.retryAfterMs }),
    ...(value.message === undefined ? {} : { message: value.message }),
  }) as LeaseRefusal;
}

export function decodeBinding(value: unknown): AllocationOperationRecord['binding'] | null {
  return value === 'unpublished' ||
    value === 'publish-pending' ||
    value === 'published' ||
    value === 'cleanup-pending' ||
    value === 'cleaned' ||
    value === 'not-applicable'
    ? value
    : null;
}

export function decodeRelease(value: unknown): AllocationOperationRecord['release'] | null {
  return value === 'not-requested' || value === 'pending' || value === 'released' ? value : null;
}

export function isActivation(value: unknown): value is 'direct' | 'external-fence' {
  return value === 'direct' || value === 'external-fence';
}
