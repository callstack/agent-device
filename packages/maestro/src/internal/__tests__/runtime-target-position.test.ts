import { expect, test } from 'vitest';
import {
  rankMaestroCandidates,
  selectMaestroPositionMatches,
  selectMaestroSnapshotMatch,
} from '../runtime-target-ranking.ts';
import { makeSnapshot } from './runtime-target-fixtures.ts';

test('uses strict top-left comparisons for all positional relations', () => {
  const snapshot = makeSnapshot([
    { index: 0, identifier: 'above', rect: { x: 20, y: 40, width: 40, height: 30 } },
    { index: 1, identifier: 'equal-y', rect: { x: 20, y: 100, width: 40, height: 30 } },
    { index: 2, identifier: 'below', rect: { x: 20, y: 160, width: 40, height: 30 } },
    { index: 3, identifier: 'left', rect: { x: 20, y: 220, width: 40, height: 30 } },
    { index: 4, identifier: 'equal-x', rect: { x: 100, y: 220, width: 40, height: 30 } },
    { index: 5, identifier: 'right', rect: { x: 180, y: 220, width: 40, height: 30 } },
    { index: 6, identifier: 'anchor', rect: { x: 100, y: 100, width: 40, height: 30 } },
  ]);

  expect(
    rankMaestroCandidates(snapshot, { id: 'below', below: { id: 'anchor' } }, 'android').matches,
  ).toHaveLength(1);
  expect(
    rankMaestroCandidates(snapshot, { id: 'above', above: { id: 'anchor' } }, 'android').matches,
  ).toHaveLength(1);
  expect(
    rankMaestroCandidates(snapshot, { id: 'left', leftOf: { id: 'anchor' } }, 'android').matches,
  ).toHaveLength(1);
  expect(
    rankMaestroCandidates(snapshot, { id: 'right', rightOf: { id: 'anchor' } }, 'android').matches,
  ).toHaveLength(1);
});

test('keeps relative pair distance as intermediate order but preserves composed base order', () => {
  const snapshot = makeSnapshot([
    { index: 0, identifier: 'far-candidate', rect: { x: 300, y: 240, width: 40, height: 30 } },
    { index: 1, identifier: 'near-candidate', rect: { x: 40, y: 140, width: 40, height: 30 } },
    { index: 2, identifier: 'near-anchor', rect: { x: 40, y: 40, width: 40, height: 30 } },
    { index: 3, identifier: 'far-anchor', rect: { x: 300, y: 40, width: 40, height: 30 } },
  ]);
  const relation = selectMaestroPositionMatches(snapshot, 'below', { id: '.*anchor' });
  expect(relation.map((node) => node.identifier)).toEqual([
    'near-candidate',
    'far-candidate',
    'near-candidate',
    'far-candidate',
  ]);
  expect(
    rankMaestroCandidates(
      snapshot,
      { id: '.*candidate', below: { id: '.*anchor' } },
      'android',
    ).matches.map((node) => node.identifier),
  ).toEqual(['far-candidate', 'near-candidate']);
});

test('excludes missing or unusable geometry from positional matches', () => {
  const snapshot = makeSnapshot([
    { index: 0, identifier: 'candidate-missing' },
    { index: 1, identifier: 'candidate-valid', rect: { x: 10, y: 200, width: 40, height: 30 } },
    { index: 2, identifier: 'anchor-missing' },
    { index: 3, identifier: 'anchor-valid', rect: { x: 10, y: 100, width: 40, height: 30 } },
  ]);
  expect(
    rankMaestroCandidates(
      snapshot,
      { id: 'candidate-.*', below: { id: 'anchor-.*' } },
      'android',
    ).matches.map((node) => node.identifier),
  ).toEqual(['candidate-valid']);
});

test('keeps finite zero-sized bounds in positional matches', () => {
  const snapshot = makeSnapshot([
    { index: 0, identifier: 'candidate-zero', rect: { x: 10, y: 200, width: 0, height: 0 } },
    { index: 1, identifier: 'candidate-positive', rect: { x: 20, y: 180, width: 40, height: 30 } },
    { index: 2, identifier: 'anchor-zero', rect: { x: 10, y: 100, width: 0, height: 0 } },
  ]);
  expect(
    rankMaestroCandidates(
      snapshot,
      { id: 'candidate-.*', below: { id: 'anchor-zero' } },
      'android',
    ).matches.map((node) => node.identifier),
  ).toEqual(['candidate-zero', 'candidate-positive']);
});

test('applies index after composed positional intersections using y then x', () => {
  const snapshot = makeSnapshot([
    { index: 0, identifier: 'candidate-low', rect: { x: 0, y: 200, width: 40, height: 30 } },
    { index: 1, identifier: 'candidate-high', rect: { x: 100, y: 120, width: 40, height: 30 } },
    { index: 2, identifier: 'lower', rect: { x: 0, y: 300, width: 40, height: 30 } },
    { index: 3, identifier: 'upper', rect: { x: 0, y: 80, width: 40, height: 30 } },
  ]);
  const selector = {
    id: 'candidate-(low|high)',
    index: 0,
    below: { id: 'upper' },
    above: { id: 'lower' },
  } as const;
  const matches = rankMaestroCandidates(snapshot, selector, 'android').matches;
  expect(matches.map((node) => node.identifier)).toEqual(['candidate-low', 'candidate-high']);
  expect(selectMaestroSnapshotMatch(matches, selector.index)).toMatchObject({
    node: { identifier: 'candidate-high' },
  });
});

test('supports positional relations nested inside tree relations and empty descendants', () => {
  const snapshot = makeSnapshot([
    { index: 0, identifier: 'card', rect: { x: 0, y: 0, width: 300, height: 250 } },
    {
      index: 1,
      parentIndex: 0,
      identifier: 'caption',
      rect: { x: 20, y: 40, width: 80, height: 30 },
    },
    {
      index: 2,
      parentIndex: 0,
      identifier: 'field',
      rect: { x: 20, y: 120, width: 80, height: 30 },
    },
  ]);
  expect(
    rankMaestroCandidates(
      snapshot,
      { id: 'card', containsChild: { id: 'field', below: { id: 'caption' } } },
      'android',
    ).matches.map((node) => node.identifier),
  ).toEqual(['card']);
  expect(
    rankMaestroCandidates(snapshot, { id: 'card', containsDescendants: [] }, 'android').matches,
  ).toHaveLength(1);
});
