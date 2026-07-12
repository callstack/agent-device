import { expect, test } from 'vitest';
import {
  findMaestroFuzzyTextMatches,
  findMaestroTypedSelectorMatches,
} from '../runtime-target-matching.ts';
import { makeSnapshot } from './runtime-target-fixtures.ts';

test('typed target matching preserves snapshot read order', () => {
  const snapshot = makeSnapshot([
    { index: 1, label: 'Save', rect: { x: 10, y: 10, width: 100, height: 40 } },
    { index: 2, label: 'Save', rect: { x: 10, y: 80, width: 100, height: 40 } },
  ]);

  expect(findMaestroTypedSelectorMatches(snapshot, { text: 'Save' }).map((node) => node.index)).toEqual([
    1,
    2,
  ]);
});

test('fuzzy target matching prefers normalized exact values over partial values', () => {
  const snapshot = makeSnapshot([
    { index: 1, label: 'Sign In Now' },
    { index: 2, label: 'sign  in' },
  ]);

  expect(findMaestroFuzzyTextMatches(snapshot, 'Sign In').map((node) => node.index)).toEqual([2]);
  expect(findMaestroFuzzyTextMatches(snapshot, 'In Now').map((node) => node.index)).toEqual([1]);
});
