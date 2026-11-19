/** A duration a daemon reported; a value that is not a finite number shows as `?`, since types are not checked at runtime. */
export function formatDurationSeconds(durationMs: number): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return '?';
  const seconds = Math.max(0, durationMs) / 1000;
  if (seconds >= 10) return `${seconds.toFixed(1)}s`;
  if (seconds >= 1) return `${seconds.toFixed(2)}s`;
  return `${seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}s`;
}

/** A count a daemon reported, as shown: a non-negative safe integer, otherwise `?`. */
export function formatReplayCount(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : '?';
}
