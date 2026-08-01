// Marks, from inside the runner, every test the runner itself aborted at its
// timeout — the only failures the contention retry lane (#1419) may rerun.
//
// `context.signal` is the runner's own AbortSignal: only the runner holds its
// controller, and it aborts with the timeout error it raised. A test body can
// throw whatever it likes, including the runner's exact timeout text, without
// ever aborting the signal.
//
// The mark is the run's secret, taken out of the environment here — before any
// test module is imported — so a test writing `task.meta` has nothing to write.

import { beforeEach, onTestFailed } from 'vitest';
import { RUNNER_TIMEOUT_META, takeRunnerTimeoutToken } from './lib/runner-timeout-meta.ts';

const TOKEN = takeRunnerTimeoutToken(process.env);

/** Distinguishes the timeout abort from a run cancellation, on the runner's own reason. */
const RUNNER_TIMEOUT_REASON = /^(Test|Hook) timed out in \d+ms\./;

function abortedByRunnerTimeout(signal: AbortSignal): boolean {
  if (!signal.aborted || !(signal.reason instanceof Error)) return false;
  return RUNNER_TIMEOUT_REASON.test(signal.reason.message);
}

beforeEach(({ signal, task }) => {
  onTestFailed(() => {
    if (TOKEN && abortedByRunnerTimeout(signal)) {
      (task.meta as Record<string, unknown>)[RUNNER_TIMEOUT_META] = TOKEN;
    }
  });
});
