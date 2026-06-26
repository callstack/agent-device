export type AudioProbeSource = 'media-elements' | 'system-audio';

export type AudioProbeResult = {
  audio: 'probe';
  state: 'running' | 'stopped';
  active: boolean;
  heard: boolean;
  source: AudioProbeSource;
  backend?: string;
  durationMs: number;
  elapsedMs: number;
  bucketMs: number;
  sampleCount: number;
  mediaElementCount?: number;
  sourceCount: number;
  rmsDbfs: number[];
  peakDbfs: number[];
  startedAt?: string;
  stoppedAt?: string;
  reason?: string;
  notes?: string[];
};

export type NormalizeAudioProbeRecordOptions = {
  source: AudioProbeSource;
  backend: string;
  durationMs: number;
  elapsedMs: number;
  bucketMs: number;
  activeFallback?: boolean;
  mediaElementCount?: number;
  sourceCount?: number;
  notes?: string[];
};

export function normalizeAudioProbeRecord(
  value: unknown,
  options: NormalizeAudioProbeRecordOptions,
): AudioProbeResult {
  const record = readRecord(value);
  const state = readAudioProbeState(record);
  const rmsDbfs = readNumberArray(record.rmsDbfs);
  const peakDbfs = readNumberArray(record.peakDbfs);
  const notes = [...(readStringArray(record.notes) ?? []), ...(options.notes ?? [])];
  return {
    audio: 'probe',
    state,
    active: state === 'running' && readBoolean(record.active, options.activeFallback ?? true),
    heard: record.heard === true,
    source: options.source,
    backend: readString(record.backend) ?? options.backend,
    durationMs: readFiniteNumber(record.durationMs, options.durationMs),
    elapsedMs: readFiniteNumber(record.elapsedMs, options.elapsedMs),
    bucketMs: readFiniteNumber(record.bucketMs, options.bucketMs),
    sampleCount: readFiniteNumber(record.sampleCount, rmsDbfs.length),
    mediaElementCount:
      options.mediaElementCount === undefined
        ? readOptionalFiniteNumber(record.mediaElementCount)
        : readFiniteNumber(record.mediaElementCount, options.mediaElementCount),
    sourceCount: readFiniteNumber(record.sourceCount, options.sourceCount ?? 0),
    rmsDbfs,
    peakDbfs,
    startedAt: readString(record.startedAt),
    stoppedAt: readString(record.stoppedAt),
    reason: readString(record.reason),
    notes: notes.length > 0 ? notes : undefined,
  };
}

function readAudioProbeState(record: Record<string, unknown>): 'running' | 'stopped' {
  return record.state === 'running' ? 'running' : 'stopped';
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item)) numbers.push(item);
  }
  return numbers;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
