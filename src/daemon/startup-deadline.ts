/**
 * Converts a `--timeout <ms>` startup budget into the absolute deadline a readiness wait honors.
 * A missing, non-finite, or non-positive budget yields `undefined`, so callers fall back to their
 * own default wait instead of silently disabling it.
 */
export function startupDeadlineAtMs(timeoutMs: unknown): number | undefined {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Date.now() + timeoutMs
    : undefined;
}
