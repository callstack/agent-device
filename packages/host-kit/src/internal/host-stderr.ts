/**
 * This process's stderr, for a report that cannot afford to depend on what it reports.
 *
 * Every route that writes a diagnostic can fail: a refused state path, a log handle that broke mid-write, a
 * pipe nobody reads. The line about that failure therefore goes to the one sink no entry in the refused
 * directory can steer, and the write is contained — a report is never worth the flow that was making it.
 *
 * This module is a leaf on purpose: the diagnostic owners reach it directly, so saying one line can never
 * pull in an owner that reports through those same lines.
 */

/** Says {@link value} and answers whether stderr took it. A stream that throws costs the line, not the caller. */
export function writeHostStderrBestEffort(value: string): boolean {
  try {
    process.stderr.write(value);
    return true;
  } catch {
    return false;
  }
}
