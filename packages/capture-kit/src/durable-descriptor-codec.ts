import { DURABLE_RESOURCE_REASONS } from '@agent-device/kernel/errors';
import type { DescriptorDecodeFailureReason } from '@agent-device/contracts/durable-resource';
import type {
  DurableDescriptorCodec,
  DurableResourceEnvelope,
} from '@agent-device/contracts/durable-resource-envelope';

export type DurableDescriptorDecodeOutcome<Descriptor extends object> =
  | Readonly<{ status: 'decoded'; descriptor: Descriptor }>
  | Readonly<{
      status: 'unreattachable';
      reason: DescriptorDecodeFailureReason;
      message: string;
      version?: number;
    }>;

/** Invoke only after the envelope's exact owner has selected the facet codec. */
export function decodeDurableDescriptor<Descriptor extends object, ResourceKind extends string>(
  envelope: DurableResourceEnvelope,
  codec: DurableDescriptorCodec<Descriptor, ResourceKind>,
): DurableDescriptorDecodeOutcome<Descriptor> {
  if (envelope.resourceKind !== codec.resourceKind) {
    return {
      status: 'unreattachable',
      reason: DURABLE_RESOURCE_REASONS.descriptorInvalid.reason,
      message: `Durable resource kind ${envelope.resourceKind} does not match ${codec.resourceKind}`,
    };
  }
  if (envelope.descriptor.version !== codec.version) {
    return {
      status: 'unreattachable',
      reason: DURABLE_RESOURCE_REASONS.descriptorVersionUnsupported.reason,
      message: `Unsupported ${codec.resourceKind} descriptor version: ${envelope.descriptor.version}`,
      version: envelope.descriptor.version,
    };
  }
  try {
    const decoded = codec.decode(envelope.descriptor.body);
    return decoded.status === 'decoded'
      ? decoded
      : {
          status: 'unreattachable',
          reason: DURABLE_RESOURCE_REASONS.descriptorInvalid.reason,
          message: decoded.message,
        };
  } catch (error) {
    return {
      status: 'unreattachable',
      reason: DURABLE_RESOURCE_REASONS.descriptorInvalid.reason,
      message: error instanceof Error ? error.message : 'Descriptor codec rejected the body',
    };
  }
}
