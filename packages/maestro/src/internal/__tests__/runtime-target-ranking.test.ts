import { expect, test } from 'vitest';
import {
  rankMaestroCandidates,
  selectMaestroSnapshotMatch,
  selectMaestroSnapshotMatches,
} from '../runtime-target-ranking.ts';
import { makeSnapshot } from './runtime-target-fixtures.ts';

test('typed target matching preserves snapshot read order', () => {
  const snapshot = makeSnapshot([
    { index: 1, label: 'Save', rect: { x: 10, y: 10, width: 100, height: 40 } },
    { index: 2, label: 'Save', rect: { x: 10, y: 80, width: 100, height: 40 } },
  ]);

  expect(
    rankMaestroCandidates(snapshot, { text: 'Save' }, 'ios').matches.map((node) => node.index),
  ).toEqual([1, 2]);
});

test('target selection preserves snapshot aggregate order when no index is authored', () => {
  const snapshot = makeSnapshot([
    {
      index: 10,
      type: 'StaticText',
      label: 'Save',
      rect: { x: 24, y: 100, width: 120, height: 44 },
    },
    {
      index: 2,
      type: 'Button',
      label: 'Save',
      rect: { x: 24, y: 300, width: 120, height: 44 },
    },
  ]);

  expect(selectMaestroSnapshotMatch(snapshot.nodes, undefined)).toMatchObject({
    node: { index: 10 },
  });
});

test('authored index sorts by y then x with missing bounds last', () => {
  const snapshot = makeSnapshot([
    {
      index: 1,
      type: 'StaticText',
      label: 'Save',
    },
    {
      index: 2,
      type: 'StaticText',
      label: 'Save',
      rect: { x: 24, y: 100, width: 120, height: 44 },
    },
    {
      index: 3,
      type: 'Button',
      label: 'Save',
      rect: { x: 24, y: 300, width: 120, height: 44 },
    },
  ]);

  expect(selectMaestroSnapshotMatch(snapshot.nodes, undefined)).toMatchObject({
    node: { index: 2 },
  });
  expect(selectMaestroSnapshotMatch(snapshot.nodes, 0)).toMatchObject({
    node: { index: 2 },
  });
  expect(selectMaestroSnapshotMatch(snapshot.nodes, 1)).toMatchObject({
    node: { index: 3 },
  });
  expect(selectMaestroSnapshotMatch(snapshot.nodes, 2)).toBeNull();
});

test('nested childOf applies its own index before scoping the candidate', () => {
  const snapshot = makeSnapshot([
    { index: 0, identifier: 'row', rect: { x: 0, y: 200, width: 200, height: 80 } },
    { index: 1, identifier: 'row', rect: { x: 0, y: 20, width: 200, height: 80 } },
    { index: 2, parentIndex: 0, label: 'Delete', rect: { x: 120, y: 220, width: 60, height: 40 } },
    { index: 3, parentIndex: 1, label: 'Delete', rect: { x: 120, y: 40, width: 60, height: 40 } },
  ]);

  expect(
    selectMaestroSnapshotMatches(snapshot, {
      text: 'Delete',
      childOf: { id: 'row', index: 1 },
    }).map((node) => node.index),
  ).toEqual([2]);
});

test('target selection never fabricates a rectangle or promotes to an ancestor', () => {
  const snapshot = makeSnapshot([
    {
      index: 1,
      type: 'Button',
      rect: { x: 20, y: 100, width: 220, height: 64 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Continue',
      rect: { x: 40, y: 112, width: 120, height: 40 },
    },
    {
      index: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Missing geometry',
    },
  ]);

  expect(selectMaestroSnapshotMatch([snapshot.nodes[0]!], undefined)).toMatchObject({
    node: { index: 1 },
    rect: { x: 20, y: 100, width: 220, height: 64 },
  });
  expect(selectMaestroSnapshotMatch([snapshot.nodes[1]!], undefined)).toMatchObject({
    node: { index: 2 },
    rect: { x: 40, y: 112, width: 120, height: 40 },
  });
  expect(selectMaestroSnapshotMatch([snapshot.nodes[2]!], undefined)).toBeNull();
});
