import { AUDIO_PROBE_RESOURCE_KIND } from '@agent-device/contracts/audio-probe-runtime';
import type { AudioProbeSource } from '@agent-device/contracts/audio-probe-result';
import type {
  DurableDescriptorCodec,
  ManagedProcessIdentity,
} from '@agent-device/contracts/platform';

/**
 * Stable reconstruction coordinates for one host audio capture. The helper transport cannot
 * reconstruct live control after daemon loss, so recovery is declared cleanup-only: the marker
 * proves exact process identity for termination, and the status file still yields a completed
 * result when the run finished on its own. The marker is required — start refuses to publish a
 * capture it could not identify, and a stored record without one (foreign or corrupted) decodes
 * as invalid so cleanup routes it to manual recovery instead of guessing at the child's fate.
 */
export type HostAudioProbeDescriptor = Readonly<{
  backend: string;
  source: AudioProbeSource;
  sourceCount: number;
  notes: readonly string[];
  statusPath: string;
  startedAt: number;
  durationMs: number;
  bucketMs: number;
  marker: ManagedProcessIdentity;
}>;

type HostAudioProbeDescriptorDecode = DurableDescriptorCodec<
  HostAudioProbeDescriptor,
  typeof AUDIO_PROBE_RESOURCE_KIND
>['decode'];

const hasValidHostAudioProbeFields = (body: Record<string, unknown>): boolean =>
  isNonEmptyString(body.backend) &&
  (body.source === 'system-audio' || body.source === 'media-elements') &&
  isBoundedInteger(body.sourceCount, 0) &&
  isStringArray(body.notes) &&
  isNonEmptyString(body.statusPath) &&
  isBoundedInteger(body.startedAt, 1) &&
  isBoundedInteger(body.durationMs, 1) &&
  isBoundedInteger(body.bucketMs, 1);

const decodeHostAudioProbeDescriptor: HostAudioProbeDescriptorDecode = (body) => {
  const marker = hasValidHostAudioProbeFields(body) ? decodeMarker(body.marker) : 'invalid';
  if (marker === 'invalid') {
    return { status: 'invalid', message: 'Audio probe descriptor body is invalid' };
  }
  const decoded = body as unknown as Omit<HostAudioProbeDescriptor, 'notes' | 'marker'> & {
    notes: readonly string[];
  };
  return {
    status: 'decoded',
    descriptor: Object.freeze({
      backend: decoded.backend,
      source: decoded.source,
      sourceCount: decoded.sourceCount,
      notes: Object.freeze([...decoded.notes]),
      statusPath: decoded.statusPath,
      startedAt: decoded.startedAt,
      durationMs: decoded.durationMs,
      bucketMs: decoded.bucketMs,
      marker,
    }),
  };
};

export const hostAudioProbeDescriptorCodec: DurableDescriptorCodec<
  HostAudioProbeDescriptor,
  typeof AUDIO_PROBE_RESOURCE_KIND
> = Object.freeze({
  resourceKind: AUDIO_PROBE_RESOURCE_KIND,
  version: 1,
  encode: (descriptor: HostAudioProbeDescriptor) => ({
    ...descriptor,
    notes: [...descriptor.notes],
    marker: { ...descriptor.marker },
  }),
  decode: decodeHostAudioProbeDescriptor,
});

function decodeMarker(value: unknown): ManagedProcessIdentity | 'invalid' {
  if (typeof value !== 'object' || value === null) return 'invalid';
  const marker = value as Record<string, unknown>;
  if (!isBoundedInteger(marker.pid, 1)) return 'invalid';
  if (!isNonEmptyString(marker.startTime)) return 'invalid';
  if (!isNonEmptyString(marker.command)) return 'invalid';
  return Object.freeze({
    pid: marker.pid,
    startTime: marker.startTime,
    command: marker.command,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isBoundedInteger(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
