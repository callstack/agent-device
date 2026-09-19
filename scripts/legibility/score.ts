// Scoring: model accuracy against the three baselines, per-family rows, and the divergence
// list. Accuracy is over answered files. A family with fewer than three sampled files gets a
// row but is kept out of every headline number, and the best/worst spread only considers
// families with at least twenty sampled files — anything smaller is a coin toss, not a spread.

import type { BaselinePrediction } from './baselines.ts';
import type { BatchRun, UnansweredReason } from './batches.ts';
import type { Corpus, CorpusFile } from './corpus.ts';

export const MIN_HEADLINE_FAMILY_N = 3;
const MIN_SPREAD_FAMILY_N = 20;

export type ScoredFile = {
  id: string;
  family: string;
  predicted: string | null;
  correct: boolean | null;
  p: number | null;
  top3: [string, number][];
  confidence: number | null;
  baselines: BaselinePrediction;
  viaRename: boolean;
  subject: string;
  unanswered: UnansweredReason | null;
};

export type FamilyRow = {
  family: string;
  files: number;
  n: number;
  answered: number;
  accuracy: number | null;
  knn: number | null;
  delta: number | null;
  medianConfidence: number | null;
  modularity: number | null;
  outInFlow: number | null;
  /** `n < MIN_HEADLINE_FAMILY_N`: shown, never averaged into a headline. */
  smallSample: boolean;
};

export type Divergence = {
  id: string;
  family: string;
  predicted: string;
  p: number | null;
  viaRename: boolean;
  subject: string;
};

export type Spread = {
  best: { family: string; accuracy: number; n: number };
  worst: { family: string; accuracy: number; n: number };
  points: number;
};

export type Headline = {
  n: number;
  answered: number;
  unanswered: number;
  /** Sampled files whose family has fewer than `MIN_HEADLINE_FAMILY_N` samples. */
  excludedSmallFamilyFiles: number;
  model: number | null;
  majority: number | null;
  neighbourVote: number | null;
  knn: number | null;
  spread: Spread | null;
};

export type Score = {
  headline: Headline;
  perFamily: FamilyRow[];
  divergences: Divergence[];
  files: ScoredFile[];
};

export type FamilyCoupling = { Q: number; outInFlow: number | null };

export type ScoreInput = {
  sample: readonly CorpusFile[];
  corpus: Corpus;
  run: BatchRun;
  baselines: ReadonlyMap<string, BaselinePrediction>;
  coupling: ReadonlyMap<string, FamilyCoupling>;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function share(hits: number, total: number): number | null {
  return total === 0 ? null : hits / total;
}

function scoredFile(file: CorpusFile, input: ScoreInput): ScoredFile {
  const answer = input.run.answers.get(file.id);
  const verdict = answer
    ? { predicted: answer.choice, correct: answer.choice === file.family, ...answer }
    : { predicted: null, correct: null, p: null, top3: [], confidence: null };
  return {
    id: file.id,
    family: file.family,
    predicted: verdict.predicted,
    correct: verdict.correct,
    p: verdict.p,
    top3: verdict.top3,
    confidence: verdict.confidence,
    baselines: input.baselines.get(file.id)!,
    viaRename: file.firstTouch?.viaRename ?? false,
    subject: file.firstTouch?.subject ?? '',
    unanswered: input.run.unanswered.get(file.id) ?? null,
  };
}

export function scoreRun(input: ScoreInput): Score {
  const files = input.sample.map((file) => scoredFile(file, input));

  const corpusCounts = new Map<string, number>();
  for (const file of input.corpus.files) {
    corpusCounts.set(file.family, (corpusCounts.get(file.family) ?? 0) + 1);
  }
  const byFamily = new Map<string, ScoredFile[]>();
  for (const file of files) {
    const list = byFamily.get(file.family) ?? [];
    list.push(file);
    byFamily.set(file.family, list);
  }

  const perFamily: FamilyRow[] = [...byFamily]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, members]) => {
      const answered = members.filter((file) => file.correct !== null);
      const accuracy = share(answered.filter((file) => file.correct).length, answered.length);
      const knn = share(
        answered.filter((file) => file.baselines.knn === file.family).length,
        answered.length,
      );
      return {
        family,
        files: corpusCounts.get(family) ?? 0,
        n: members.length,
        answered: answered.length,
        accuracy,
        knn,
        delta: accuracy === null || knn === null ? null : accuracy - knn,
        medianConfidence: median(
          answered.flatMap((file) => (file.confidence === null ? [] : [file.confidence])),
        ),
        modularity: input.coupling.get(family)?.Q ?? null,
        outInFlow: input.coupling.get(family)?.outInFlow ?? null,
        smallSample: members.length < MIN_HEADLINE_FAMILY_N,
      };
    });

  const headlineFamilies = new Set(
    perFamily.filter((row) => !row.smallSample).map((row) => row.family),
  );
  const headlineFiles = files.filter((file) => headlineFamilies.has(file.family));
  const answered = headlineFiles.filter((file) => file.correct !== null);
  const accuracyOf = (predict: (file: ScoredFile) => string | null) =>
    share(answered.filter((file) => predict(file) === file.family).length, answered.length);

  const spreadRows = perFamily.filter(
    (row) => row.n >= MIN_SPREAD_FAMILY_N && row.accuracy !== null,
  );
  const ranked = [...spreadRows].sort(
    (a, b) => b.accuracy! - a.accuracy! || a.family.localeCompare(b.family),
  );
  const spread: Spread | null =
    ranked.length >= 2
      ? {
          best: { family: ranked[0]!.family, accuracy: ranked[0]!.accuracy!, n: ranked[0]!.n },
          worst: {
            family: ranked.at(-1)!.family,
            accuracy: ranked.at(-1)!.accuracy!,
            n: ranked.at(-1)!.n,
          },
          points: (ranked[0]!.accuracy! - ranked.at(-1)!.accuracy!) * 100,
        }
      : null;

  const divergences: Divergence[] = files
    .filter(
      (file) =>
        file.predicted !== null &&
        file.predicted !== file.family &&
        file.baselines.knn === file.predicted,
    )
    .map((file) => ({
      id: file.id,
      family: file.family,
      predicted: file.predicted!,
      p: file.p,
      viaRename: file.viaRename,
      subject: file.subject,
    }));

  return {
    headline: {
      n: files.length,
      answered: files.filter((file) => file.correct !== null).length,
      unanswered: files.filter((file) => file.correct === null).length,
      excludedSmallFamilyFiles: files.length - headlineFiles.length,
      model: accuracyOf((file) => file.predicted),
      majority: accuracyOf((file) => file.baselines.majority),
      neighbourVote: accuracyOf((file) => file.baselines.neighbourVote),
      knn: accuracyOf((file) => file.baselines.knn),
      spread,
    },
    perFamily,
    divergences,
    files,
  };
}
