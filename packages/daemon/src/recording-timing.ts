type GestureTimingSource = {
  recordingStartedAt: number;
  gestureClockOriginAtMs?: number;
  gestureClockOriginUptimeMs?: number;
  runnerStartedAtUptimeMs?: number;
  gestureStartUptimeMs?: number;
  gestureEndUptimeMs?: number;
  fallbackStartedAtMs: number;
  fallbackFinishedAtMs: number;
};

type GestureDurationSource = {
  gestureStartUptimeMs?: number;
  gestureEndUptimeMs?: number;
  reportedDurationMs?: number;
  fallbackStartedAtMs: number;
  fallbackFinishedAtMs: number;
};

type TapVisualizationOffsetSource = GestureTimingSource & {
  gestureDurationMs: number;
};

export function resolveGestureOffsetMs(source: GestureTimingSource): number {
  if (
    typeof source.gestureClockOriginAtMs === 'number' &&
    typeof source.gestureClockOriginUptimeMs === 'number' &&
    typeof source.gestureStartUptimeMs === 'number'
  ) {
    const wallClockAtGestureStart =
      source.gestureClockOriginAtMs +
      (source.gestureStartUptimeMs - source.gestureClockOriginUptimeMs);
    return Math.max(0, wallClockAtGestureStart - source.recordingStartedAt);
  }
  if (
    typeof source.runnerStartedAtUptimeMs === 'number' &&
    typeof source.gestureStartUptimeMs === 'number'
  ) {
    return Math.max(0, source.gestureStartUptimeMs - source.runnerStartedAtUptimeMs);
  }
  if (
    typeof source.gestureStartUptimeMs === 'number' &&
    typeof source.gestureEndUptimeMs === 'number'
  ) {
    const wallClockAtGestureStart =
      source.fallbackFinishedAtMs - (source.gestureEndUptimeMs - source.gestureStartUptimeMs);
    return Math.max(0, wallClockAtGestureStart - source.recordingStartedAt);
  }
  return Math.max(0, source.fallbackStartedAtMs - source.recordingStartedAt);
}

export function resolveGestureDurationMs(source: GestureDurationSource): number {
  if (
    typeof source.gestureStartUptimeMs === 'number' &&
    typeof source.gestureEndUptimeMs === 'number'
  ) {
    return Math.max(0, source.gestureEndUptimeMs - source.gestureStartUptimeMs);
  }
  if (typeof source.reportedDurationMs === 'number') {
    return Math.max(0, source.reportedDurationMs);
  }
  return Math.max(0, source.fallbackFinishedAtMs - source.fallbackStartedAtMs);
}

export function resolveTapVisualizationOffsetMs(source: TapVisualizationOffsetSource): number {
  const durationMs = Math.max(0, source.gestureDurationMs);
  if (durationMs < 600) {
    return resolveGestureOffsetMs(source);
  }

  // Long tap-like commands can spend most of their wall-clock time in selector resolution or
  // XCTest idle waiting. In that case, show the overlay shortly before completion instead of
  // anchoring it to the full command runtime.
  const leadMs = Math.min(Math.max(durationMs * 0.15, 120), 260);
  return Math.max(0, source.fallbackFinishedAtMs - leadMs - source.recordingStartedAt);
}
