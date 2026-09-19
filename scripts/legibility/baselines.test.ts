import assert from 'node:assert/strict';
import { test } from 'node:test';
import { miniCorpus } from './__fixtures__/mini-corpus.ts';
import {
  baselinePredictions,
  jaccard,
  knnPredict,
  majorityFamily,
  neighbourVote,
} from './baselines.ts';

const corpus = miniCorpus();
const file = (id: string) => corpus.byId.get(id)!;

test('majority is the largest family, ties broken by name', () => {
  assert.equal(majorityFamily(corpus), 'beta');
});

test('neighbour-vote needs a strict majority of import targets and abstains otherwise', () => {
  assert.equal(neighbourVote(file('src/beta/x.ts'), corpus), 'beta');
  assert.equal(
    neighbourVote(file('src/beta/y.ts'), corpus),
    null,
    'one alpha, one beta: no majority',
  );
  assert.equal(neighbourVote(file('src/beta/z.ts'), corpus), 'alpha');
  assert.equal(neighbourVote(file('packages/alpha/src/b.ts'), corpus), null, 'no imports');
  assert.equal(neighbourVote(file('src/gamma.ts'), corpus), 'beta');
});

test('jaccard over import-path sets', () => {
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  assert.equal(jaccard([], []), 0);
  assert.equal(jaccard(['a'], ['a']), 1);
});

test('k-NN votes by similarity over the other files and falls back for files without imports', () => {
  assert.equal(knnPredict(file('packages/alpha/src/a.ts'), corpus, 'fallback'), 'beta');
  assert.equal(knnPredict(file('packages/alpha/src/b.ts'), corpus, 'fallback'), 'fallback');
  assert.equal(knnPredict(file('src/gamma.ts'), corpus, 'fallback'), 'fallback', 'no overlap');
  assert.equal(knnPredict(file('src/beta/y.ts'), corpus, 'fallback', 1), 'beta', 'x is nearest');
});

test('baseline predictions bundle all three', () => {
  assert.deepEqual(baselinePredictions(file('src/beta/x.ts'), corpus), {
    majority: 'beta',
    neighbourVote: 'beta',
    knn: 'beta',
  });
});
