import type { ManagedShapeRequest } from '@agent-device/contracts/managed-device-allocation';
import type { JsonObject } from '@agent-device/contracts/client';
import type {
  AllocationOperationPhase,
  AllocationOperationRecord,
} from './allocation-operation-record.ts';
import { allocationOperationFence } from './allocation-operation-fence.ts';
import { ALLOCATION_OPERATION_SCHEMA_VERSION } from './allocation-operation-schema.ts';
import {
  isFenceGeneration,
  isFiniteNumber,
  isPlainObject,
  isRequestGeneration,
  isVerbatimId,
} from './allocation-operation-record-validation.ts';
import { decodeAllocationAttribution } from './allocation-operation-record-json.ts';
import {
  checkConsistency,
  decodeBinding,
  decodePhase,
  decodeRelease,
  decodeShape,
  isActivation,
} from './allocation-operation-record-codec-state.ts';

export type AllocationOperationDecoding =
  | Readonly<{ status: 'decoded'; record: AllocationOperationRecord }>
  | AllocationOperationUnreadable;

export type AllocationOperationUnreadable = Readonly<{
  status: 'unreadable';
  reason: AllocationOperationUnreadableReason;
  message: string;
  version?: number;
}>;

export type AllocationOperationUnreadableReason =
  | 'corrupt'
  | 'unsupported-version'
  | 'ambiguous'
  | 'unfenced';

type DecodeResult<T> = T | AllocationOperationUnreadable;
type RawAllocationRecord = Record<string, unknown>;

type DecodedBaseFields = Readonly<{
  requesterId: string;
  attemptKey: string;
  allocatorInstanceId: string;
  shape: ManagedShapeRequest;
  deadlineAtMs: number;
  requestGeneration: number;
  activation: 'direct' | 'external-fence';
  createdAtMs: number;
  updatedAtMs: number;
  attribution?: JsonObject;
  identityIncarnationId?: string;
}>;

type DecodedStateFields = Readonly<{
  phase: AllocationOperationPhase;
  binding: AllocationOperationRecord['binding'];
  release: AllocationOperationRecord['release'];
}>;

export function decodeAllocationOperationRecord(value: unknown): AllocationOperationDecoding {
  const object = decodeObject(value);
  if (isUnreadable(object)) return object;
  const version = decodeVersion(object);
  if (version) return version;
  const base = decodeBaseFields(object);
  if (isUnreadable(base)) return base;
  const fence = decodeFence(base, object.fence);
  if (isUnreadable(fence)) return fence;
  const state = decodeStateFields(object, base.identityIncarnationId);
  if (isUnreadable(state)) return state;
  return createDecodedRecord(base, fence.fence, state);
}

function decodeObject(value: unknown): DecodeResult<RawAllocationRecord> {
  return isPlainObject(value) ? value : unreadable('corrupt', 'allocation record is not an object');
}

function decodeVersion(value: RawAllocationRecord): AllocationOperationUnreadable | undefined {
  if (value.schemaVersion === ALLOCATION_OPERATION_SCHEMA_VERSION) return undefined;
  return unreadable(
    'unsupported-version',
    `unsupported allocation record version ${String(value.schemaVersion)}`,
    typeof value.schemaVersion === 'number' ? value.schemaVersion : undefined,
  );
}

function decodeBaseFields(value: RawAllocationRecord): DecodeResult<DecodedBaseFields> {
  const identifiers = decodeIdentifiers(value);
  if (isUnreadable(identifiers)) return identifiers;
  const request = decodeRequestFields(value);
  if (isUnreadable(request)) return request;
  const times = decodeTimes(value);
  if (isUnreadable(times)) return times;
  const optional = decodeOptionalFields(value);
  if (isUnreadable(optional)) return optional;
  return { ...identifiers, ...request, ...times, ...optional };
}

function decodeIdentifiers(
  value: RawAllocationRecord,
): DecodeResult<Pick<DecodedBaseFields, 'requesterId' | 'attemptKey' | 'allocatorInstanceId'>> {
  const requesterId = isVerbatimId(value.requesterId) ? value.requesterId : undefined;
  const attemptKey = isVerbatimId(value.attemptKey) ? value.attemptKey : undefined;
  const allocatorInstanceId = isVerbatimId(value.allocatorInstanceId)
    ? value.allocatorInstanceId
    : undefined;
  return requesterId && attemptKey && allocatorInstanceId
    ? { requesterId, attemptKey, allocatorInstanceId }
    : unreadable('corrupt', 'allocation record identifiers are invalid');
}

function decodeRequestFields(
  value: RawAllocationRecord,
): DecodeResult<Pick<DecodedBaseFields, 'shape' | 'requestGeneration' | 'activation'>> {
  const shape = decodeShape(value.shape);
  const requestGeneration = isRequestGeneration(value.requestGeneration)
    ? value.requestGeneration
    : undefined;
  if (!shape) return unreadable('corrupt', 'allocation record shape is invalid');
  if (value.admission !== 'fail-fast' || !isActivation(value.activation)) {
    return unreadable('corrupt', 'allocation record request policy is invalid');
  }
  if (requestGeneration === undefined) {
    return unreadable('corrupt', 'allocation record request generation is invalid');
  }
  return { shape, requestGeneration, activation: value.activation };
}

function decodeTimes(
  value: RawAllocationRecord,
): DecodeResult<Pick<DecodedBaseFields, 'deadlineAtMs' | 'createdAtMs' | 'updatedAtMs'>> {
  const deadlineAtMs = isFiniteNumber(value.deadlineAtMs) ? value.deadlineAtMs : undefined;
  const createdAtMs = isFiniteNumber(value.createdAtMs) ? value.createdAtMs : undefined;
  const updatedAtMs = isFiniteNumber(value.updatedAtMs) ? value.updatedAtMs : undefined;
  if (deadlineAtMs === undefined || createdAtMs === undefined || updatedAtMs === undefined) {
    return unreadable('corrupt', 'allocation record timestamps are invalid');
  }
  if (updatedAtMs < createdAtMs) {
    return unreadable('ambiguous', 'allocation record update precedes its creation');
  }
  return { deadlineAtMs, createdAtMs, updatedAtMs };
}

function decodeOptionalFields(
  value: RawAllocationRecord,
): DecodeResult<Pick<DecodedBaseFields, 'attribution' | 'identityIncarnationId'>> {
  const identityIncarnationId = decodeIdentity(value.identityIncarnationId);
  if (value.identityIncarnationId !== undefined && identityIncarnationId === undefined) {
    return unreadable('corrupt', 'allocation record identity incarnation is invalid');
  }
  const attribution = decodeAllocationAttribution(value.attribution);
  if (value.attribution !== undefined && attribution === undefined) {
    return unreadable('corrupt', 'allocation record attribution is invalid');
  }
  return {
    ...(identityIncarnationId === undefined ? {} : { identityIncarnationId }),
    ...(attribution === undefined ? {} : { attribution }),
  };
}

function decodeIdentity(value: unknown): string | undefined {
  return value === undefined ? undefined : isVerbatimId(value) ? value : undefined;
}

function decodeStateFields(
  value: RawAllocationRecord,
  identityIncarnationId: string | undefined,
): DecodeResult<DecodedStateFields> {
  const phase = decodePhase(value.phase);
  const binding = decodeBinding(value.binding);
  const release = decodeRelease(value.release);
  if (!phase || !binding || !release) {
    return unreadable('corrupt', 'allocation record cleanup state is invalid');
  }
  const consistency = checkConsistency({ phase, identityIncarnationId, binding, release });
  return consistency ? unreadable('ambiguous', consistency) : { phase, binding, release };
}

function createDecodedRecord(
  base: DecodedBaseFields,
  fence: ReturnType<typeof allocationOperationFence>,
  state: DecodedStateFields,
): AllocationOperationDecoding {
  return {
    status: 'decoded',
    record: Object.freeze({
      schemaVersion: ALLOCATION_OPERATION_SCHEMA_VERSION,
      ...base,
      admission: 'fail-fast' as const,
      fence,
      phase: Object.freeze(state.phase),
      binding: state.binding,
      release: state.release,
    }),
  };
}

function isUnreadable<T>(value: DecodeResult<T>): value is AllocationOperationUnreadable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'unreadable'
  );
}

function decodeFence(
  ref: Pick<DecodedBaseFields, 'requesterId' | 'attemptKey'>,
  value: unknown,
):
  | Readonly<{ status: 'decoded'; fence: ReturnType<typeof allocationOperationFence> }>
  | AllocationOperationUnreadable {
  if (
    !isPlainObject(value) ||
    typeof value.token !== 'string' ||
    !isFenceGeneration(value.generation)
  ) {
    return unreadable('unfenced', 'allocation record has no valid transition fence');
  }
  let expected: ReturnType<typeof allocationOperationFence>;
  try {
    expected = allocationOperationFence(ref, value.generation);
  } catch {
    return unreadable('unfenced', 'allocation record transition fence cannot be reconstructed');
  }
  return expected.token === value.token
    ? { status: 'decoded', fence: expected }
    : unreadable('unfenced', 'allocation record transition fence does not name its operation');
}

function unreadable(
  reason: AllocationOperationUnreadableReason,
  message: string,
  version?: number,
): AllocationOperationUnreadable {
  return { status: 'unreadable', reason, message, ...(version === undefined ? {} : { version }) };
}
