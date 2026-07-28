// Process-level blockers for the contention single-retry policy (#1419).
//
// The reporter can only see what happened inside the run. Two failure classes
// live outside it and would otherwise be erased by a green retry: a coverage
// verdict (computed after the tests, and a whole-suite property a file-scoped
// rerun cannot re-establish), and any nonzero exit no failed test explains
// (worker crash, config error, report never written). Both are recorded as
// blockers, which forbid the retry outright.

import type { RunBlocker } from './contention-retry.ts';

/** Vitest's own coverage verdict lines (`checkCoverages`, vitest 4). */
const COVERAGE_FAILURE = [
  /ERROR: Coverage for [a-z]+ \([\d.]+%\) does not meet (?:global )?threshold/i,
  /ERROR: Coverage for [a-z]+ \([\d.]+%\) does not meet .*minimum threshold/i,
];

export type ProcessOutcome = {
  ok: boolean;
  /** Combined stdout+stderr of the run. */
  output: string;
  failureCount: number;
};

export function processBlockers(outcome: ProcessOutcome): RunBlocker[] {
  if (outcome.ok) return [];
  const blockers: RunBlocker[] = [];
  const coverage = outcome.output
    .split('\n')
    .filter((line) => COVERAGE_FAILURE.some((pattern) => pattern.test(line)));
  for (const line of coverage) {
    blockers.push({ kind: 'coverage threshold', detail: line.trim() });
  }
  if (outcome.failureCount === 0 && blockers.length === 0) {
    blockers.push({
      kind: 'unexplained failure',
      detail: 'the run exited nonzero with no failed test recorded — see the job log',
    });
  }
  return blockers;
}
