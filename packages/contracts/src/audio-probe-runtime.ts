import type { AudioProbeResult, AudioProbeSource } from './audio-probe-result.ts';
import type { CleanupOutcome, LiveResourceHandle, ReattachOutcome } from './durable-resource.ts';
import type { DurableResourceEnvelope } from './durable-resource-envelope.ts';
import type { PendingTransferGuard } from './async-lifecycle.ts';
import type { ResourceOwnershipFence, RuntimeOperationFact } from './platform-runtime.ts';

export const AUDIO_PROBE_RESOURCE_KIND = 'audio-probe' as const;

/**
 * Static identity of one live host audio capture. Mutable sampling state stays behind the status
 * file the native helper owns; the daemon session holds only the handle plus its durable envelope.
 */
export type AudioProbeLiveSnapshot = Readonly<{
  source: AudioProbeSource;
  backend: string;
  sourceCount: number;
  notes: readonly string[];
  statusPath: string;
  startedAt: number;
  durationMs: number;
  bucketMs: number;
}>;

/** Final metadata rendering the unchanged public audio probe stop/status response. */
export type AudioProbeCompletion = AudioProbeResult;

export type AudioProbeLiveHandle = LiveResourceHandle<AudioProbeCompletion> &
  Readonly<{
    inspect(): AudioProbeLiveSnapshot;
    /** Live sampling state for `audio probe status` while the capture is running. */
    status(): Promise<AudioProbeResult>;
  }>;

export type AudioProbeStartInput = Readonly<{
  sessionId: string;
  statusPath: string;
  durationMs: number;
  bucketMs: number;
  fence: ResourceOwnershipFence;
}>;

export type AudioProbeStartResult = Readonly<{
  pendingHandle: PendingTransferGuard<AudioProbeLiveHandle>;
  envelope: DurableResourceEnvelope<typeof AUDIO_PROBE_RESOURCE_KIND>;
}>;

export type AudioProbeReattachInput = Readonly<{
  envelope: DurableResourceEnvelope<typeof AUDIO_PROBE_RESOURCE_KIND>;
}>;

export type AudioProbeQueryAction = 'start' | 'status' | 'stop';

export type AudioProbeQueryInput = Readonly<{
  action: AudioProbeQueryAction;
  durationMs: number;
  bucketMs: number;
}>;

export type AudioProbeRuntimeOperations = Readonly<{
  audioProbeStart(input: AudioProbeStartInput): Promise<AudioProbeStartResult>;
  audioProbeReattach(
    input: AudioProbeReattachInput,
  ): Promise<ReattachOutcome<AudioProbeLiveHandle, AudioProbeCompletion>>;
  audioProbeCleanup(input: AudioProbeReattachInput): Promise<CleanupOutcome>;
  /**
   * Stateless probe for owners whose sampling state lives inside the target itself (the web
   * page's AudioContext); nothing durable outlives the request on the daemon side.
   */
  audioProbeQuery(input: AudioProbeQueryInput): Promise<AudioProbeResult>;
}>;

/**
 * The two audio fact cells expanded onto their operation names. Capture covers the durable
 * trio uniformly — an owner that can start the host capture is the same exact owner that
 * reattaches and cleans it up.
 */
export function audioProbeRuntimeOperationFacts(
  cells: Readonly<{ capture: RuntimeOperationFact; query: RuntimeOperationFact }>,
): Readonly<{
  audioProbeStart: RuntimeOperationFact;
  audioProbeReattach: RuntimeOperationFact;
  audioProbeCleanup: RuntimeOperationFact;
  audioProbeQuery: RuntimeOperationFact;
}> {
  return Object.freeze({
    audioProbeStart: cells.capture,
    audioProbeReattach: cells.capture,
    audioProbeCleanup: cells.capture,
    audioProbeQuery: cells.query,
  });
}
