// How a gate reporter that fails a run without failing a test makes that verdict
// visible to the other reporters in the run (#1419).

import type { RunBlocker } from './contention-retry.ts';

const blockers: RunBlocker[] = [];

/** Publish a verdict that fails the run. Every gate reporter must call this. */
export function recordRunBlocker(blocker: RunBlocker): void {
  blockers.push(blocker);
}

/** Take everything published so far, clearing the channel. Drained after the gates run. */
export function drainRunBlockers(): RunBlocker[] {
  return blockers.splice(0, blockers.length);
}
