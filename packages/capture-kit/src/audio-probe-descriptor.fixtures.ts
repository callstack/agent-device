import {
  hostAudioProbeDescriptorCodec,
  type HostAudioProbeDescriptor,
} from './audio-probe-descriptor.ts';
import { encodeDurableDescriptor } from './durable-resource-envelope.ts';

/** The descriptor a live host audio probe persists, for seeding a record an earlier daemon left. */
export function encodeHostAudioProbeDescriptor(descriptor: HostAudioProbeDescriptor) {
  return encodeDurableDescriptor(hostAudioProbeDescriptorCodec, descriptor);
}
