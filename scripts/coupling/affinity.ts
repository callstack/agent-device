// Logical coupling from co-change: a commit touching `k >= 2` production files adds
// `1 / (k - 1)` to each unordered pair, and `support` counts the commits containing the pair.
// Commits over `maxFiles` are mass migrations — they would connect everything to everything —
// so they are skipped and reported, never silently folded in. Edges below `minSupport` are cut.

import type { HistoryCommit } from '../repo-history/commits.ts';

export type CouplingEdge = { a: string; b: string; weight: number; support: number };

export type AffinityOptions = { maxFiles: number; minSupport: number };

export const DEFAULT_AFFINITY_OPTIONS: AffinityOptions = { maxFiles: 60, minSupport: 3 };

export type SkippedCommit = { sha: string; subject: string; files: number };

export type AffinityResult = {
  /** Kept edges, heaviest first, then by pair key. */
  edges: CouplingEdge[];
  /** Commits that touch at least one current production file, whatever their size. */
  touchingCommits: number;
  /** Commits that contributed pair weight: `2 <= k <= maxFiles`. */
  usedCommits: number;
  skipped: SkippedCommit[];
  /** Pairs seen before the support cut. */
  rawEdges: number;
};

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

export function splitPairKey(key: string): [string, string] {
  const [a = '', b = ''] = key.split('\n');
  return [a, b];
}

/** True when a commit is a mass migration under the declared threshold. */
export function isMassCommit(commit: HistoryCommit, maxFiles: number): boolean {
  return commit.files.length > maxFiles;
}

type PairWeights = Map<string, { weight: number; support: number }>;

/** One commit's contribution: `1 / (k - 1)` to each unordered pair, one support each. */
function addPairWeights(files: readonly string[], weights: PairWeights): void {
  const share = 1 / (files.length - 1);
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const key = pairKey(files[i]!, files[j]!);
      const entry = weights.get(key) ?? { weight: 0, support: 0 };
      entry.weight += share;
      entry.support += 1;
      weights.set(key, entry);
    }
  }
}

export function buildAffinity(
  commits: readonly HistoryCommit[],
  options: AffinityOptions = DEFAULT_AFFINITY_OPTIONS,
): AffinityResult {
  const weights = new Map<string, { weight: number; support: number }>();
  const skipped: SkippedCommit[] = [];
  let touchingCommits = 0;
  let usedCommits = 0;
  for (const commit of commits) {
    const k = commit.files.length;
    if (k === 0) continue;
    touchingCommits += 1;
    if (isMassCommit(commit, options.maxFiles)) {
      skipped.push({ sha: commit.sha, subject: commit.subject, files: k });
      continue;
    }
    if (k < 2) continue;
    usedCommits += 1;
    addPairWeights(commit.files, weights);
  }
  const edges: CouplingEdge[] = [];
  for (const [key, { weight, support }] of weights) {
    if (support < options.minSupport) continue;
    const [a, b] = splitPairKey(key);
    edges.push({ a, b, weight, support });
  }
  edges.sort(
    (left, right) =>
      right.weight - left.weight ||
      pairKey(left.a, left.b).localeCompare(pairKey(right.a, right.b)),
  );
  return { edges, touchingCommits, usedCommits, skipped, rawEdges: weights.size };
}
