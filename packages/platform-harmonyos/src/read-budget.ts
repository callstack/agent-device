/**
 * The budget one device read gets: its own default, or the request deadline's remainder when the
 * request leaves less room. A spent deadline answers 0, so the caller skips the device instead of
 * arming a timer with no room to run.
 */
export function remainingReadBudgetMs(
  defaultBudgetMs: number,
  requestDeadlineAtMs: number | undefined,
): number {
  if (requestDeadlineAtMs === undefined) return defaultBudgetMs;
  return Math.min(defaultBudgetMs, Math.max(0, requestDeadlineAtMs - Date.now()));
}
