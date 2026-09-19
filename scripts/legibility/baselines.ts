// The three baselines a legibility number is read against. Majority predicts the largest
// family for everything. Neighbour-vote predicts the family that holds a strict majority of a
// file's value-import targets and abstains (scored wrong) when no family does or the file
// imports nothing — a plurality with a majority fallback is nearly 1-NN and reads 43% on this
// tree, not the 28% the issue's evidence records. k-NN votes over the k most similar files by
// Jaccard similarity of import-path sets, self excluded.
//
// All three read the physical layout: they know which family every other file sits in. That is
// what a reader who has browsed the tree knows, and it is exactly the knowledge the
// name-withheld condition takes away. So these baselines are comparable to the `reader` model
// number and to nothing else — a model denied the directory names cannot beat them by
// construction, and its margin over k-NN under `reader` is what judgement adds on top of
// neighbourhood, not what names carry. `majority` is the one floor that survives any condition.

import type { Corpus, CorpusFile } from './corpus.ts';

const DEFAULT_KNN_K = 5;

export type BaselinePrediction = {
  majority: string;
  /** `null` when no family holds a strict majority of the import targets. */
  neighbourVote: string | null;
  knn: string;
};

export function majorityFamily(corpus: Corpus): string {
  const counts = new Map<string, number>();
  for (const file of corpus.files) counts.set(file.family, (counts.get(file.family) ?? 0) + 1);
  return [...counts].sort(([a, n], [b, m]) => m - n || a.localeCompare(b))[0]![0];
}

export function neighbourVote(file: CorpusFile, corpus: Corpus): string | null {
  const votes = new Map<string, number>();
  let total = 0;
  for (const target of file.imports) {
    const family = corpus.byId.get(target)?.family;
    if (family === undefined) continue;
    votes.set(family, (votes.get(family) ?? 0) + 1);
    total += 1;
  }
  for (const [family, count] of votes) if (count * 2 > total) return family;
  return null;
}

export function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  const rightSet = new Set(right);
  let intersection = 0;
  for (const item of left) if (rightSet.has(item)) intersection += 1;
  const union = left.length + right.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function knnPredict(
  file: CorpusFile,
  corpus: Corpus,
  fallback: string,
  k = DEFAULT_KNN_K,
): string {
  if (file.imports.length === 0) return fallback;
  const neighbours: { family: string; similarity: number; id: string }[] = [];
  for (const other of corpus.files) {
    if (other.id === file.id) continue;
    const similarity = jaccard(file.imports, other.imports);
    if (similarity > 0) neighbours.push({ family: other.family, similarity, id: other.id });
  }
  if (neighbours.length === 0) return fallback;
  neighbours.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
  const votes = new Map<string, number>();
  for (const neighbour of neighbours.slice(0, k)) {
    votes.set(neighbour.family, (votes.get(neighbour.family) ?? 0) + neighbour.similarity);
  }
  const ranked = [...votes].sort(([, n], [, m]) => m - n);
  const best = ranked[0]![1];
  const tied = ranked.filter(([, weight]) => weight === best).map(([family]) => family);
  return tied.length === 1 ? tied[0]! : neighbours.find((n) => tied.includes(n.family))!.family;
}

export function baselinePredictions(
  file: CorpusFile,
  corpus: Corpus,
  majority = majorityFamily(corpus),
  k = DEFAULT_KNN_K,
): BaselinePrediction {
  return {
    majority,
    neighbourVote: neighbourVote(file, corpus),
    knn: knnPredict(file, corpus, majority, k),
  };
}
