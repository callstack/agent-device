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
import type { JsonObject } from '@agent-device/contracts/client';
import type {
  DurableDescriptorCodec,
  DurableEnvelopeDecodeOutcome,
  DurableResourceEnvelope,
  DurableResourceLifecycleState,
  EncodedDurableDescriptor,
} from '@agent-device/contracts/durable-resource-envelope';
import {
  type ResourceOwnershipFence,
  type RuntimeOwnerRef,
  localRuntimeOwner,
  managedLocalRuntimeOwner,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import { freezeJsonObject, isBoundedJsonObject } from './durable-json.ts';

const DURABLE_RESOURCE_ENVELOPE_VERSION = 1 as const;

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
  if (value.metadata !== undefined && !isBoundedJsonObject(value.metadata)) {
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
  if (value.kind === 'managed-local' && isNonEmptyString(value.instance)) {
    return managedLocalRuntimeOwner(value.instance);
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

export function decodeDeviceIdentity(value: unknown): DeviceIdentity | null {
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
  if (
    !isObject(value) ||
    !isNonNegativeInteger(value.version) ||
    !isBoundedJsonObject(value.body)
  ) {
    return null;
  }
  return Object.freeze({ version: value.version, body: freezeJsonObject(value.body) });
}

function isLifecycleState(value: unknown): value is DurableResourceLifecycleState {
  return value === 'open' || value === 'completed';
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
