// Family span per commit: how many distinct families one change touches. Mass commits are
// skipped under the same threshold affinity uses, so the histogram and the edge set describe the
// same usable commits. The median and the `>= 5` share are taken over commits spanning at least
// two families — a single-family commit has nothing to say about cross-family change.

import type { HistoryCommit } from '../repo-history/commits.ts';
import { isMassCommit } from './affinity.ts';
import type { FamilyOf } from './modularity.ts';

export type FamilySpan = {
  /** Distinct-family count -> number of usable commits with that span. */
  histogram: Record<string, number>;
  usableCommits: number;
  multiFamilyCommits: number;
  /** Median span over multi-family commits; `null` when there are none. */
  median: number | null;
  /** Share of multi-family commits spanning five or more families; `null` when there are none. */
  shareAtLeast5: number | null;
};

export function familiesTouched(commit: HistoryCommit, familyOf: FamilyOf): number {
  return new Set(commit.files.map(familyOf)).size;
}

export function familySpan(
  commits: readonly HistoryCommit[],
  familyOf: FamilyOf,
  maxFiles: number,
): FamilySpan {
  const histogram: Record<string, number> = {};
  const multi: number[] = [];
  let usableCommits = 0;
  for (const commit of commits) {
    if (commit.files.length === 0 || isMassCommit(commit, maxFiles)) continue;
    usableCommits += 1;
    const span = familiesTouched(commit, familyOf);
    histogram[span] = (histogram[span] ?? 0) + 1;
    if (span >= 2) multi.push(span);
  }
  multi.sort((left, right) => left - right);
  const median =
    multi.length === 0
      ? null
      : multi.length % 2 === 1
        ? multi[(multi.length - 1) / 2]!
        : (multi[multi.length / 2 - 1]! + multi[multi.length / 2]!) / 2;
  return {
    histogram,
    usableCommits,
    multiFamilyCommits: multi.length,
    median,
    shareAtLeast5:
      multi.length === 0 ? null : multi.filter((span) => span >= 5).length / multi.length,
  };
}
