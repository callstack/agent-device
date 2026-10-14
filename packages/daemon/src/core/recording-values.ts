export function readRecordingNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveRecordingDurationMs(
  gestureDurationMs: number,
  candidates: readonly unknown[],
  fallbackDurationMs: number,
): number {
  for (const value of [gestureDurationMs, ...candidates, fallbackDurationMs]) {
    const durationMs = readRecordingNumber(value);
    if (durationMs !== undefined && durationMs >= 1) return Math.floor(durationMs);
  }
  return fallbackDurationMs;
}
