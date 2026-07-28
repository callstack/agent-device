// Marks, from inside the runner, every test the runner itself aborted at its
// timeout — the only failures the contention retry lane (#1419) may rerun.
//
// `context.signal` is the runner's own AbortSignal: only the runner holds its
// controller, and it aborts with the timeout error it raised. A test body can
// throw whatever it likes, including the runner's exact timeout text, without
// ever aborting the signal.

import { beforeEach, onTestFailed } from 'vitest';
import { RUNNER_TIMEOUT_META } from './lib/runner-timeout-meta.ts';

/** Distinguishes the timeout abort from a run cancellation, on the runner's own reason. */
const RUNNER_TIMEOUT_REASON = /^(Test|Hook) timed out in \d+ms\./;

beforeEach(({ signal, task }) => {
  onTestFailed(() => {
    if (
      signal.aborted &&
      signal.reason instanceof Error &&
      RUNNER_TIMEOUT_REASON.test(signal.reason.message)
    ) {
      task.meta[RUNNER_TIMEOUT_META] = true;
    }
  });
});
