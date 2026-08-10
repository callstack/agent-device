import type {
  DurableDescriptorCodec,
  DurableResourceEnvelope,
} from '@agent-device/contracts/platform';

export type DurableDescriptorDecodeOutcome<Descriptor extends object> =
  | Readonly<{ status: 'decoded'; descriptor: Descriptor }>
  | Readonly<{
      status: 'unreattachable';
      reason: 'descriptor-invalid' | 'descriptor-version-unsupported';
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
      reason: 'descriptor-invalid',
      message: `Durable resource kind ${envelope.resourceKind} does not match ${codec.resourceKind}`,
    };
  }
  if (envelope.descriptor.version !== codec.version) {
    return {
      status: 'unreattachable',
      reason: 'descriptor-version-unsupported',
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
          reason: 'descriptor-invalid',
          message: decoded.message,
        };
  } catch (error) {
    return {
      status: 'unreattachable',
      reason: 'descriptor-invalid',
      message: error instanceof Error ? error.message : 'Descriptor codec rejected the body',
    };
  }
}
