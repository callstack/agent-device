// Blockers a reporter cannot see, read from the run's process outcome (#1419):
// the coverage verdict, and any nonzero exit no failed test explains.

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
