import assert from 'node:assert/strict';
import { test } from 'node:test';
import { miniCorpus } from './__fixtures__/mini-corpus.ts';
import type { BaselinePrediction } from './baselines.ts';
import type { BatchRun, FileAnswer } from './batches.ts';
import { MIN_HEADLINE_FAMILY_N, scoreRun } from './score.ts';

const corpus = miniCorpus();

function answer(
  id: string,
  choice: string,
  p: number | null = 0.7,
  confidence: number | null = 0.5,
): FileAnswer {
  return { id, choice, p, top3: p === null ? [] : [[choice, p]], confidence };
}

function run(answers: FileAnswer[], unanswered: BatchRun['unanswered'] = new Map()): BatchRun {
  return {
    answers: new Map(answers.map((entry) => [entry.id, entry])),
    unanswered,
    requests: 1,
    splits: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

const baselines = new Map<string, BaselinePrediction>(
  corpus.files.map((file) => [
    file.id,
    {
      majority: 'beta',
      neighbourVote: file.id === 'src/beta/x.ts' ? 'beta' : null,
      knn: file.id === 'packages/alpha/src/a.ts' ? 'beta' : file.family,
    },
  ]),
);
const coupling = new Map([
  ['alpha', { Q: 0.1, outInFlow: 2 }],
  ['beta', { Q: 0.2, outInFlow: null }],
]);

test('per-family rows exist for every sampled family and small ones stay out of the headline', () => {
  const score = scoreRun({
    sample: corpus.files,
    corpus,
    run: run([
      answer('packages/alpha/src/a.ts', 'beta'),
      answer('packages/alpha/src/b.ts', 'alpha', null, null),
      answer('src/beta/x.ts', 'beta', 0.9, 0.9),
      answer('src/beta/y.ts', 'alpha', 0.5, 0.3),
      answer('src/gamma.ts', '(root)'),
    ]),
    baselines,
    coupling,
  });
  assert.deepEqual(
    score.perFamily.map((row) => [row.family, row.files, row.n, row.answered, row.smallSample]),
    [
      ['(root)', 1, 1, 1, true],
      ['alpha', 2, 2, 2, true],
      ['beta', 3, 3, 2, false],
    ],
  );
  const beta = score.perFamily.find((row) => row.family === 'beta')!;
  assert.deepEqual(
    [beta.accuracy, beta.knn, beta.delta, beta.medianConfidence, beta.modularity, beta.outInFlow],
    [0.5, 1, -0.5, 0.6, 0.2, null],
  );
  assert.equal(score.perFamily.find((row) => row.family === '(root)')!.modularity, null);
  assert.equal(MIN_HEADLINE_FAMILY_N, 3);
  assert.deepEqual(score.headline, {
    n: 6,
    answered: 5,
    unanswered: 1,
    excludedSmallFamilyFiles: 3,
    model: 0.5,
    majority: 1,
    neighbourVote: 0.5,
    knn: 1,
    spread: null,
  });
});

test('divergences are files where model and k-NN agree on another family, with the rename flag', () => {
  const score = scoreRun({
    sample: corpus.files,
    corpus,
    run: run([answer('packages/alpha/src/a.ts', 'beta', 0.55), answer('src/beta/z.ts', 'alpha')]),
    baselines,
    coupling,
  });
  assert.deepEqual(score.divergences, [
    {
      id: 'packages/alpha/src/a.ts',
      family: 'alpha',
      predicted: 'beta',
      p: 0.55,
      viaRename: false,
      subject: 'add alpha module',
    },
  ]);
  const z = score.files.find((file) => file.id === 'src/beta/z.ts')!;
  assert.deepEqual([z.correct, z.viaRename, z.baselines.knn], [false, true, 'beta']);
});

test('an unanswered file keeps its typed reason and never counts as answered', () => {
  const score = scoreRun({
    sample: corpus.files,
    corpus,
    run: run([], new Map([['src/beta/x.ts', { kind: 'request-cap', maxRequests: 1 }]])),
    baselines,
    coupling,
  });
  const x = score.files.find((file) => file.id === 'src/beta/x.ts')!;
  assert.deepEqual(
    [x.predicted, x.correct, x.unanswered],
    [null, null, { kind: 'request-cap', maxRequests: 1 }],
  );
  assert.equal(score.headline.answered, 0);
  assert.equal(score.headline.model, null);
});
