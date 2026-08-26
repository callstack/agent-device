import fs from 'node:fs/promises';
import type {
  AudioProbeCompletion,
  AudioProbeLiveSnapshot,
} from '@agent-device/contracts/audio-probe-runtime';
import {
  emptyAudioProbeResult,
  normalizeAudioProbeRecord,
  type AudioProbeResult,
} from '@agent-device/contracts/audio-probe-result';

/** The identity fields both the live handle and daemon-loss recovery read status against. */
export type StatusIdentity = Pick<
  AudioProbeLiveSnapshot,
  | 'source'
  | 'backend'
  | 'sourceCount'
  | 'notes'
  | 'statusPath'
  | 'startedAt'
  | 'durationMs'
  | 'bucketMs'
>;

export async function readStatusFile(
  snapshot: StatusIdentity,
): Promise<AudioProbeResult | undefined> {
  try {
    const raw = await fs.readFile(snapshot.statusPath, 'utf8');
    return normalizeAudioProbeRecord(JSON.parse(raw), {
      source: snapshot.source,
      backend: snapshot.backend,
      durationMs: snapshot.durationMs,
      elapsedMs: Date.now() - snapshot.startedAt,
      bucketMs: snapshot.bucketMs,
      activeFallback: true,
      sourceCount: snapshot.sourceCount,
      notes: [...snapshot.notes],
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function finalizeStatus(
  snapshot: StatusIdentity,
  status: AudioProbeResult | undefined,
  reason: string,
): AudioProbeCompletion {
  const elapsedMs = Math.min(snapshot.durationMs, Math.max(0, Date.now() - snapshot.startedAt));
  const base =
    status ??
    emptyAudioProbeResult({
      source: snapshot.source,
      backend: snapshot.backend,
      durationMs: snapshot.durationMs,
      bucketMs: snapshot.bucketMs,
      sourceCount: snapshot.sourceCount,
      notes: [...snapshot.notes],
    });
  return {
    ...base,
    state: 'stopped',
    active: false,
    elapsedMs,
    stoppedAt: new Date().toISOString(),
    reason,
  };
}
