const MAX_WORST_WINDOWS = 3;
// Dropped frames separated by more than 500ms are reported as separate jank clusters.
const JANK_WINDOW_GAP_NS = 500_000_000;
const MIN_DISPLAY_FRAME_INTERVAL_NS = 4_000_000;
const MAX_DISPLAY_FRAME_INTERVAL_NS = 50_000_000;

export type AndroidFrameStatsRow = {
  intendedVsyncNs: number;
  frameCompletedNs: number;
  durationNs: number;
};

export type AndroidFrameDropWindow = {
  startOffsetMs: number;
  endOffsetMs: number;
  startAt?: string;
  endAt?: string;
  missedDeadlineFrameCount: number;
  worstFrameMs: number;
};

export function deriveFrameDeadlineNs(frames: AndroidFrameStatsRow[]): number | undefined {
  const intendedVsyncs = uniqueSortedNumbers(frames.map((frame) => frame.intendedVsyncNs));
  const deltas: number[] = [];
  for (let index = 1; index < intendedVsyncs.length; index += 1) {
    const delta = intendedVsyncs[index]! - intendedVsyncs[index - 1]!;
    if (delta >= MIN_DISPLAY_FRAME_INTERVAL_NS && delta <= MAX_DISPLAY_FRAME_INTERVAL_NS) {
      deltas.push(delta);
    }
  }
  if (deltas.length === 0) return undefined;
  return median(deltas);
}

export function selectDroppedFrameRows(options: {
  frames: AndroidFrameStatsRow[];
  frameDeadlineNs?: number;
  summaryDroppedFrameCount?: number;
}): AndroidFrameStatsRow[] {
  const { frames, frameDeadlineNs, summaryDroppedFrameCount } = options;
  if (summaryDroppedFrameCount !== undefined) {
    if (summaryDroppedFrameCount <= 0) return [];
    // Android's janky-frame summary is authoritative, but framestats rows do not expose
    // the exact summary classification. Use the slowest rows only for approximate attribution.
    return [...frames]
      .sort((left, right) => right.durationNs - left.durationNs)
      .slice(0, summaryDroppedFrameCount)
      .sort((left, right) => left.intendedVsyncNs - right.intendedVsyncNs);
  }
  if (frameDeadlineNs === undefined) return [];
  return frames.filter((frame) => frame.durationNs > frameDeadlineNs);
}

export function buildWorstFrameDropWindows(options: {
  frames: AndroidFrameStatsRow[];
  windowStartNs?: number;
  measuredAtMs: number;
  uptimeMs?: number;
}): AndroidFrameDropWindow[] {
  const { frames, windowStartNs, measuredAtMs, uptimeMs } = options;
  if (frames.length === 0 || windowStartNs === undefined) return [];

  const windows: AndroidFrameStatsRow[][] = [];
  let current: AndroidFrameStatsRow[] = [];
  for (const frame of frames) {
    const previous = current.at(-1);
    if (!previous || frame.intendedVsyncNs - previous.frameCompletedNs <= JANK_WINDOW_GAP_NS) {
      current.push(frame);
      continue;
    }
    windows.push(current);
    current = [frame];
  }
  if (current.length > 0) windows.push(current);

  return windows
    .map((windowFrames) =>
      buildFrameDropWindow({
        frames: windowFrames,
        windowStartNs,
        measuredAtMs,
        uptimeMs,
      }),
    )
    .sort(
      (left, right) =>
        right.missedDeadlineFrameCount - left.missedDeadlineFrameCount ||
        right.worstFrameMs - left.worstFrameMs,
    )
    .slice(0, MAX_WORST_WINDOWS)
    .sort((left, right) => left.startOffsetMs - right.startOffsetMs);
}

export function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function buildFrameDropWindow(options: {
  frames: AndroidFrameStatsRow[];
  windowStartNs: number;
  measuredAtMs: number;
  uptimeMs?: number;
}): AndroidFrameDropWindow {
  const { frames, windowStartNs, measuredAtMs, uptimeMs } = options;
  const startNs = Math.min(...frames.map((frame) => frame.intendedVsyncNs));
  const endNs = Math.max(...frames.map((frame) => frame.frameCompletedNs));
  const startOffsetMs = Math.max(0, Math.round((startNs - windowStartNs) / 1_000_000));
  const endOffsetMs = Math.max(startOffsetMs, Math.round((endNs - windowStartNs) / 1_000_000));
  const base =
    uptimeMs !== undefined && Number.isFinite(measuredAtMs) ? measuredAtMs - uptimeMs : undefined;
  return {
    startOffsetMs,
    endOffsetMs,
    startAt: base === undefined ? undefined : new Date(base + startNs / 1_000_000).toISOString(),
    endAt: base === undefined ? undefined : new Date(base + endNs / 1_000_000).toISOString(),
    missedDeadlineFrameCount: frames.length,
    worstFrameMs: roundOneDecimal(Math.max(...frames.map((frame) => frame.durationNs)) / 1_000_000),
  };
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value)))].sort(
    (left, right) => left - right,
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint]!;
  return (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
}
