// Structured blocker channel between Vitest reporters (#1419).
//
// A gate reporter that fails a run without failing a test (the slow-test
// ratchet, for example) is invisible to anything that only reads test results:
// the contention retry lane would see one retry-eligible timeout, rerun it, and
// the green rerun would erase the gate's verdict. Gates publish their verdict
// here instead, and the retry lane's failure sink drains it — both reporters run
// in the same Vitest process, and the sink is ordered last in
// `vitest.config.ts`'s `reporters()` so every gate has already reported.

import type { RunBlocker } from './contention-retry.ts';

const blockers: RunBlocker[] = [];

/** Publish a verdict that fails the run without failing a test. */
export function recordRunBlocker(blocker: RunBlocker): void {
  blockers.push(blocker);
}

/** Take everything published so far, clearing the channel. */
export function drainRunBlockers(): RunBlocker[] {
  return blockers.splice(0, blockers.length);
}
