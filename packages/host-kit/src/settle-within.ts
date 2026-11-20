/**
 * The one deadline-settle primitive, as a dependency-free leaf: this module imports nothing, so
 * reaching it costs an entry exactly its own two statements. `@agent-device/host-kit/retry`
 * re-exports it beside `Deadline`, `sleep` and `pollUntilSettled`; a caller that needs ONLY this
 * waits on this subpath, so it never evaluates the retry policy, diagnostics or error vocabulary
 * the retry façade carries with it (the eager-closure gate measures the difference).
 */

/** What {@link settleWithin} reports: the work settled first, or the deadline won. */
export type SettleWithinOutcome<T> = { kind: 'settled'; value: T } | { kind: 'deadline' };

/**
 * Settles `work` within `timeoutMs` and reports which happened: `{ kind: 'settled', value }` when
 * the work finished first, `{ kind: 'deadline' }` when the budget elapsed first. The deadline
 * timer is cleared on every path, so it never outlives this call. This does not cancel the work:
 * when the deadline wins, `work` keeps running to its own end and a rejection arriving after the
 * deadline is swallowed here — the outcome is already `{ kind: 'deadline' }`, and the rejection
 * stays observed, so it never reaches the unhandled-rejection path. A rejection that beats the
 * deadline propagates to the caller. With a spent (zero) budget the deadline is already eligible
 * to win before the work's first continuation runs, so a caller that must see the work's own
 * failure, even at budget zero, has to await the work, not this wrapper.
 *
 * With `options.keepAlive: false` the deadline timer is also unref'd, so a deadline awaited by a
 * background sweep does not hold the event loop open while it waits (a hung sweep must not keep a
 * process with no other ref'd handles alive until the budget elapses). The default keeps the
 * timer ref'd, for shutdown callers where an unref'd timer could let the process exit mid-report.
 */
export function settleWithin<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  options?: Readonly<{ keepAlive?: boolean }>,
): Promise<SettleWithinOutcome<T>> {
  return new Promise<SettleWithinOutcome<T>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        resolve({ kind: 'deadline' });
      },
      Math.max(0, timeoutMs),
    );
    if (options?.keepAlive === false) timer.unref?.();
    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ kind: 'settled', value });
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}
