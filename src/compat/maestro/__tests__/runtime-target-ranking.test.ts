import { expect, test } from 'vitest';
import { selectMaestroSnapshotMatch } from '../runtime-target-ranking.ts';
import { makeSnapshot } from './runtime-target-fixtures.ts';

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

test('target selection preserves authored index identity before usability filtering', () => {
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
  expect(selectMaestroSnapshotMatch(snapshot.nodes, 0)).toBeNull();
  expect(selectMaestroSnapshotMatch(snapshot.nodes, 1)).toMatchObject({
    node: { index: 2 },
  });
  expect(selectMaestroSnapshotMatch(snapshot.nodes, 2)).toMatchObject({
    node: { index: 3 },
  });
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
