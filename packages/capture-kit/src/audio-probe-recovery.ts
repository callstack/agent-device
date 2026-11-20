import type {
  AudioProbeCompletion,
  AudioProbeLiveHandle,
  AudioProbeReattachInput,
} from '@agent-device/contracts/audio-probe-runtime';
import type { HostSystemAudioCaptureHost } from '@agent-device/contracts/audio-probe-runtime-host';
import type { CleanupOutcome, ReattachOutcome } from '@agent-device/contracts/durable-resource';
import { hostAudioProbeDescriptorCodec } from './audio-probe-descriptor.ts';
import { finalizeStatus, readStatusFile } from './audio-probe-status.ts';
import { decodeDurableDescriptor } from './durable-descriptor-codec.ts';

/**
 * Cleanup-only recovery operations shared by every darwin-hosted owner family. Reattach never
 * reconstructs live control: a finished run reports `completed` from the status file, a live or
 * uncertain sampler stays `unreattachable` for descriptor cleanup to terminate by exact identity.
 * The descriptor codec requires the marker, so a markerless record never reaches the liveness
 * probe — it decodes as invalid and cleanup routes it to manual recovery rather than reading a
 * possibly in-progress status file as finished.
 */
export function createHostAudioProbeRecoveryOperations(params: {
  host: Pick<HostSystemAudioCaptureHost, 'inspectProcess' | 'terminateProcess'>;
}): Readonly<{
  audioProbeReattach(
    input: AudioProbeReattachInput,
  ): Promise<ReattachOutcome<AudioProbeLiveHandle, AudioProbeCompletion>>;
  audioProbeCleanup(input: AudioProbeReattachInput): Promise<CleanupOutcome>;
}> {
  const { host } = params;
  return Object.freeze({
    audioProbeReattach: async (input) => {
      const decoded = decodeDurableDescriptor(input.envelope, hostAudioProbeDescriptorCodec);
      if (decoded.status !== 'decoded') return decoded;
      const descriptor = decoded.descriptor;
      const liveness = await host.inspectProcess(descriptor.marker);
      if (liveness === 'owned-alive') {
        return { status: 'unreattachable', reason: 'transport-not-reattachable' };
      }
      if (liveness === 'ownership-lost') {
        return { status: 'unreattachable', reason: 'ownership-fence-lost' };
      }
      const status = await readStatusFile(descriptor);
      // Only a terminal publication proves the run finished: a `running` checkpoint with the
      // child gone means the sampler died mid-capture, and its result is lost — never finalize
      // that checkpoint as a completion.
      if (status === undefined || status.state !== 'stopped') return { status: 'missing' };
      return {
        status: 'completed',
        result: finalizeStatus(descriptor, status, 'daemon-recovery'),
      };
    },
    audioProbeCleanup: async (input) => {
      const decoded = decodeDurableDescriptor(input.envelope, hostAudioProbeDescriptorCodec);
      if (decoded.status !== 'decoded') {
        return {
          status: 'cleanup-pending',
          reason: 'manual-recovery-required',
          message: decoded.message,
        };
      }
      const descriptor = decoded.descriptor;
      const liveness = await host.inspectProcess(descriptor.marker);
      if (liveness === 'ownership-lost') {
        return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
      }
      if (liveness === 'missing') return { status: 'already-missing' };
      const terminated = await host.terminateProcess(descriptor.marker);
      if (terminated === 'ownership-lost') {
        return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
      }
      return { status: terminated === 'terminated' ? 'cleaned' : 'already-missing' };
    },
  });
}
