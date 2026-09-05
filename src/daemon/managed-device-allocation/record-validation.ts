import type {
  LeaseRefusal,
  ManagedLease,
  ManagedShapeRequest,
} from '@agent-device/contracts/managed-device-allocation';
import { isBoundedJsonObject } from '@agent-device/capture-kit';
import type { NewAllocationOperationInput } from './record.ts';

export function isAllocationRequest(fields: NewAllocationOperationInput): boolean {
  return (
    isVerbatimId(fields.requesterId) &&
    isVerbatimId(fields.attemptKey) &&
    isVerbatimId(fields.allocatorInstanceId) &&
    isRequestGeneration(fields.requestGeneration) &&
    isFiniteNumber(fields.deadlineAtMs) &&
    isFiniteNumber(fields.nowMs) &&
    fields.admission === 'fail-fast' &&
    (fields.activation === 'direct' || fields.activation === 'external-fence') &&
    isValidShape(fields.shape) &&
    (fields.attribution === undefined || isBoundedJsonObject(fields.attribution))
  );
}

function isValidShape(shape: ManagedShapeRequest): boolean {
  return (
    isPlainObject(shape) &&
    (shape.platform === 'ios' || shape.platform === 'android') &&
    isNonEmptyString(shape.deviceType) &&
    (shape.osVersion === undefined || isNonEmptyString(shape.osVersion))
  );
}

export function isValidLease(lease: ManagedLease): boolean {
  return (
    isPlainObject(lease) &&
    isVerbatimId(lease.id) &&
    isFiniteNumber(lease.ttlDeadline) &&
    isPlainObject(lease.device) &&
    isVerbatimId(lease.device.address) &&
    isPlainObject(lease.environment) &&
    Object.values(lease.environment).every((value) => typeof value === 'string')
  );
}

export function isValidRefusal(refusal: LeaseRefusal): boolean {
  return (
    isPlainObject(refusal) &&
    [
      'simulator-capacity',
      'disk-low',
      'invalid-shape',
      'preparation-required',
      'requester-busy',
    ].includes(refusal.reason) &&
    (refusal.retryAfterMs === undefined || isFiniteNumber(refusal.retryAfterMs)) &&
    (refusal.message === undefined || isNonEmptyString(refusal.message))
  );
}

export function freezeLease(lease: ManagedLease): ManagedLease {
  return Object.freeze({
    id: lease.id,
    ttlDeadline: lease.ttlDeadline,
    device: Object.freeze({ address: lease.device.address }),
    environment: Object.freeze({ ...lease.environment }),
  });
}

export function freezeRefusal(refusal: LeaseRefusal): LeaseRefusal {
  return Object.freeze({ ...refusal });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isVerbatimId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isRequestGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

export function isFenceGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
