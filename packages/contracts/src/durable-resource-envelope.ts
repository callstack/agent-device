import type { DeviceIdentity } from '@agent-device/kernel/device';
import type { JsonObject } from './json.ts';
import type { ResourceOwnershipFence, RuntimeOwnerRef } from './platform-runtime.ts';

export type DurableResourceLifecycleState = 'open' | 'completed';

export type EncodedDurableDescriptor = Readonly<{
  version: number;
  body: JsonObject;
}>;

/** Persisted neutral coordinates. Live handles and platform objects are deliberately absent. */
export type DurableResourceEnvelope<ResourceKind extends string = string> = Readonly<{
  envelopeVersion: 1;
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
