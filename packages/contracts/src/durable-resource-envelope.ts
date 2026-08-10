import {
  isAppleOs,
  isPlatform,
  type AppleOS,
  type DeviceIdentity,
  type DeviceInfo,
  type DeviceKind,
  type DeviceTarget,
  type Platform,
} from '@agent-device/kernel/device';
import type { JsonObject, JsonValue } from './json.ts';
import {
  localRuntimeOwner,
  providerRuntimeOwner,
  type ResourceOwnershipFence,
  type RuntimeOwnerRef,
} from './platform-runtime.ts';

const DURABLE_RESOURCE_ENVELOPE_VERSION = 1 as const;

export type DurableResourceLifecycleState =
  | 'starting'
  | 'active'
  | 'completing'
  | 'completed'
  | 'cleanup-pending';

export type EncodedDurableDescriptor = Readonly<{
  version: number;
  body: JsonObject;
}>;

/** Persisted neutral coordinates. Live handles and platform objects are deliberately absent. */
export type DurableResourceEnvelope<ResourceKind extends string = string> = Readonly<{
  envelopeVersion: typeof DURABLE_RESOURCE_ENVELOPE_VERSION;
  resourceKind: ResourceKind;
  sessionId: string;
  device: DeviceIdentity;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  lifecycle: DurableResourceLifecycleState;
  descriptor: EncodedDurableDescriptor;
  metadata?: JsonObject;
}>;

export type DurableEnvelopeDecodeOutcome =
  | Readonly<{ status: 'decoded'; envelope: DurableResourceEnvelope }>
  | Readonly<{
      status: 'unreattachable';
      reason: 'descriptor-invalid' | 'descriptor-version-unsupported';
      message: string;
      version?: number;
    }>;

export function decodeDurableResourceEnvelope(value: unknown): DurableEnvelopeDecodeOutcome {
  if (!isObject(value)) return invalidEnvelope('Durable resource envelope must be an object');

  const envelopeVersion = value.envelopeVersion;
  if (!isNonNegativeInteger(envelopeVersion)) {
    return invalidEnvelope('Durable resource envelopeVersion must be a non-negative integer');
  }
  if (envelopeVersion !== DURABLE_RESOURCE_ENVELOPE_VERSION) {
    return {
      status: 'unreattachable',
      reason: 'descriptor-version-unsupported',
      message: `Unsupported durable resource envelope version: ${envelopeVersion}`,
      version: envelopeVersion,
    };
  }

  if (!isNonEmptyString(value.resourceKind)) {
    return invalidEnvelope('Durable resource resourceKind must be a non-empty string');
  }
  if (!isNonEmptyString(value.sessionId)) {
    return invalidEnvelope('Durable resource sessionId must be a non-empty string');
  }
  const device = decodeDeviceIdentity(value.device);
  if (!device) return invalidEnvelope('Durable resource device identity is invalid');
  const owner = decodeRuntimeOwnerRef(value.owner);
  if (!owner) return invalidEnvelope('Durable resource owner reference is invalid');
  if (owner.kind === 'local-family' && owner.family !== device.family) {
    return invalidEnvelope('Durable resource local owner does not match the device family');
  }
  const fence = decodeFence(value.fence);
  if (!fence) return invalidEnvelope('Durable resource ownership fence is invalid');
  if (!isLifecycleState(value.lifecycle)) {
    return invalidEnvelope('Durable resource lifecycle state is invalid');
  }
  const descriptor = decodeEncodedDescriptor(value.descriptor);
  if (!descriptor) return invalidEnvelope('Durable resource descriptor is invalid');
  if (value.metadata !== undefined && !isJsonObject(value.metadata)) {
    return invalidEnvelope('Durable resource metadata must be a JSON object');
  }

  return {
    status: 'decoded',
    envelope: Object.freeze({
      envelopeVersion: DURABLE_RESOURCE_ENVELOPE_VERSION,
      resourceKind: value.resourceKind,
      sessionId: value.sessionId,
      device,
      owner,
      fence,
      lifecycle: value.lifecycle,
      descriptor,
      ...(value.metadata === undefined ? {} : { metadata: freezeJsonObject(value.metadata) }),
    }),
  };
}

export type DurableDescriptorCodec<
  Descriptor extends object,
  ResourceKind extends string,
> = Readonly<{
  resourceKind: ResourceKind;
  version: number;
  encode(descriptor: Descriptor): JsonObject;
  decode(body: JsonObject): DurableDescriptorBodyDecodeOutcome<Descriptor>;
}>;

export type DurableDescriptorBodyDecodeOutcome<Descriptor extends object> =
  | Readonly<{ status: 'decoded'; descriptor: Descriptor }>
  | Readonly<{ status: 'invalid'; message: string }>;

export function encodeDurableDescriptor<Descriptor extends object, ResourceKind extends string>(
  codec: DurableDescriptorCodec<Descriptor, ResourceKind>,
  descriptor: Descriptor,
): EncodedDurableDescriptor {
  return Object.freeze({
    version: codec.version,
    body: freezeJsonObject(codec.encode(descriptor)),
  });
}

export function createDurableResourceEnvelope<ResourceKind extends string>(input: {
  resourceKind: ResourceKind;
  sessionId: string;
  device: DeviceIdentity;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  lifecycle: DurableResourceLifecycleState;
  descriptor: EncodedDurableDescriptor;
  metadata?: JsonObject;
}): DurableResourceEnvelope<ResourceKind> {
  const decoded = decodeDurableResourceEnvelope({
    envelopeVersion: DURABLE_RESOURCE_ENVELOPE_VERSION,
    ...input,
  });
  if (decoded.status !== 'decoded') {
    throw new TypeError(decoded.message);
  }
  return decoded.envelope as DurableResourceEnvelope<ResourceKind>;
}

function invalidEnvelope(message: string): DurableEnvelopeDecodeOutcome {
  return { status: 'unreattachable', reason: 'descriptor-invalid', message };
}

function decodeRuntimeOwnerRef(value: unknown): RuntimeOwnerRef | null {
  if (!isObject(value)) return null;
  if (value.kind === 'local-family' && isPlatform(value.family)) {
    return localRuntimeOwner(value.family);
  }
  if (
    value.kind === 'provider-runtime' &&
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.instance)
  ) {
    return providerRuntimeOwner(value.provider, value.instance);
  }
  return null;
}

function decodeDeviceIdentity(value: unknown): DeviceIdentity | null {
  if (!isObject(value)) return null;
  const id = readDeviceIdentityId(value.id);
  const family = readDeviceIdentityFamily(value.family);
  const kind = readDeviceIdentityKind(value.kind);
  const target = readDeviceIdentityTarget(value.target);
  if (!id || !family || !kind || target === null) return null;
  if (!hasCoherentAppleIdentity(value, family, kind)) return null;
  return buildDeviceIdentity(value, id, family, kind, target);
}

function buildDeviceIdentity(
  value: Record<string, unknown> & {
    appleOs?: AppleOS;
    iosPhysicalDeviceBackend?: DeviceInfo['iosPhysicalDeviceBackend'];
  },
  id: string,
  family: Platform,
  kind: DeviceKind,
  target: DeviceTarget | undefined,
): DeviceIdentity {
  return Object.freeze({
    id,
    family,
    ...(value.appleOs === undefined ? {} : { appleOs: value.appleOs }),
    kind,
    ...(target === undefined ? {} : { target }),
    ...(value.iosPhysicalDeviceBackend === undefined
      ? {}
      : { iosPhysicalDeviceBackend: value.iosPhysicalDeviceBackend }),
  });
}

function readDeviceIdentityId(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function readDeviceIdentityFamily(value: unknown): Platform | null {
  return isPlatform(value) ? value : null;
}

function readDeviceIdentityKind(value: unknown): DeviceKind | null {
  return isDeviceKind(value) ? value : null;
}

function readDeviceIdentityTarget(value: unknown): DeviceTarget | undefined | null {
  if (value === undefined) return undefined;
  return isDeviceTarget(value) ? value : null;
}

function hasCoherentAppleIdentity(
  value: Record<string, unknown>,
  family: Platform,
  kind: DeviceKind,
): value is Record<string, unknown> & {
  appleOs?: AppleOS;
  iosPhysicalDeviceBackend?: DeviceInfo['iosPhysicalDeviceBackend'];
} {
  if (family === 'apple') {
    if (!isAppleOs(value.appleOs)) return false;
  } else if (value.appleOs !== undefined || value.iosPhysicalDeviceBackend !== undefined) {
    return false;
  }
  return hasValidPhysicalAppleBackend(value.iosPhysicalDeviceBackend, kind);
}

function hasValidPhysicalAppleBackend(value: unknown, kind: DeviceKind): boolean {
  if (value === undefined) return true;
  if (kind !== 'device') return false;
  return value === 'coredevice' || value === 'xctest';
}

function decodeFence(value: unknown): ResourceOwnershipFence | null {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.token) ||
    !isNonNegativeInteger(value.generation)
  ) {
    return null;
  }
  return Object.freeze({ token: value.token, generation: value.generation });
}

function decodeEncodedDescriptor(value: unknown): EncodedDurableDescriptor | null {
  if (!isObject(value) || !isNonNegativeInteger(value.version) || !isJsonObject(value.body)) {
    return null;
  }
  return Object.freeze({ version: value.version, body: freezeJsonObject(value.body) });
}

function isLifecycleState(value: unknown): value is DurableResourceLifecycleState {
  return (
    value === 'starting' ||
    value === 'active' ||
    value === 'completing' ||
    value === 'completed' ||
    value === 'cleanup-pending'
  );
}

function isDeviceKind(value: unknown): value is DeviceKind {
  return value === 'simulator' || value === 'emulator' || value === 'device';
}

function isDeviceTarget(value: unknown): value is DeviceTarget {
  return value === 'mobile' || value === 'tv' || value === 'desktop';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isBoundedJsonObject(value, { seen: new WeakSet(), nodes: 0 }, 0);
}

type JsonValidationState = {
  seen: WeakSet<object>;
  nodes: number;
};

const MAX_DESCRIPTOR_JSON_DEPTH = 32;
const MAX_DESCRIPTOR_JSON_NODES = 4_096;

function isBoundedJsonObject(
  value: unknown,
  state: JsonValidationState,
  depth: number,
): value is JsonObject {
  if (!isObject(value) || depth > MAX_DESCRIPTOR_JSON_DEPTH) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (state.seen.has(value)) return false;
  state.seen.add(value);
  state.nodes += 1;
  const valid =
    state.nodes <= MAX_DESCRIPTOR_JSON_NODES &&
    Object.values(value).every((item) => isJsonValue(item, state, depth + 1));
  state.seen.delete(value);
  return valid;
}

function isJsonValue(
  value: unknown,
  state: JsonValidationState,
  depth: number,
): value is JsonValue {
  if (isJsonScalar(value)) return true;
  if (depth > MAX_DESCRIPTOR_JSON_DEPTH) return false;
  if (Array.isArray(value)) return isBoundedJsonArray(value, state, depth);
  return isBoundedJsonObject(value, state, depth);
}

function isJsonScalar(value: unknown): value is null | string | boolean | number {
  if (value === null) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' || typeof value === 'boolean';
}

function isBoundedJsonArray(
  value: unknown[],
  state: JsonValidationState,
  depth: number,
): value is JsonValue[] {
  if (state.seen.has(value)) return false;
  state.seen.add(value);
  state.nodes += 1;
  const withinLimit = state.nodes <= MAX_DESCRIPTOR_JSON_NODES;
  const valid = withinLimit && value.every((item) => isJsonValue(item, state, depth + 1));
  state.seen.delete(value);
  return valid;
}

function freezeJsonObject(value: JsonObject): JsonObject {
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeJsonValue(item)])),
  );
}

function freezeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJsonValue)) as JsonValue[];
  if (isJsonObject(value)) return freezeJsonObject(value);
  return value;
}
