import assert from 'node:assert/strict';
import { test } from 'node:test';
import { miniCorpus } from './__fixtures__/mini-corpus.ts';
import { allocateQuotas, seededRandom, stratifiedSample } from './sampling.ts';

test('the seeded generator is deterministic', () => {
  const first = Array.from({ length: 5 }, seededRandom(42));
  const second = Array.from({ length: 5 }, seededRandom(42));
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, Array.from({ length: 5 }, seededRandom(43)));
  for (const value of first) assert.ok(value >= 0 && value < 1);
});

test('quotas are proportional, at least one per family, and sum to the requested size', () => {
  const sizes = new Map([
    ['a', 100],
    ['b', 10],
    ['c', 1],
  ]);
  assert.deepEqual(
    [...allocateQuotas(sizes, 12)],
    [
      ['a', 10],
      ['b', 1],
      ['c', 1],
    ],
  );
  const tight = allocateQuotas(sizes, 5);
  assert.deepEqual(
    [...tight],
    [
      ['a', 3],
      ['b', 1],
      ['c', 1],
    ],
  );
});

test('the same seed picks the same files; every family is represented', () => {
  const corpus = miniCorpus();
  const first = stratifiedSample(corpus, 4, 7).map((file) => file.id);
  const second = stratifiedSample(corpus, 4, 7).map((file) => file.id);
  assert.deepEqual(first, second);
  assert.equal(first.length, 4);
  const families = new Set(first.map((id) => corpus.byId.get(id)!.family));
  assert.deepEqual([...families].sort(), ['(root)', 'alpha', 'beta']);
  assert.equal(first.filter((id) => id.startsWith('src/beta/')).length, 2);
  assert.equal(stratifiedSample(corpus, 100, 7).length, corpus.files.length);
});
