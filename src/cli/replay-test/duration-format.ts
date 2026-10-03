export function formatDurationSeconds(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  if (seconds >= 10) return `${seconds.toFixed(1)}s`;
  if (seconds >= 1) return `${seconds.toFixed(2)}s`;
  return `${seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}s`;
}
