import { expect, test } from 'vitest';
import { selectMaestroSnapshotMatch } from '../runtime-target-ranking.ts';
import { IOS_TAB_FRAME, makeSnapshot } from './runtime-target-fixtures.ts';

test('target ranking promotes actionable controls over matching static text', () => {
  const snapshot = makeSnapshot([
    {
      index: 1,
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

  expect(
    selectMaestroSnapshotMatch(snapshot.nodes, snapshot.nodes, undefined, 'Save', IOS_TAB_FRAME),
  ).toMatchObject({ node: { index: 2 } });
});

test('target ranking promotes a matched label to a useful actionable ancestor', () => {
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
  ]);

  expect(
    selectMaestroSnapshotMatch(
      snapshot.nodes,
      [snapshot.nodes[1]!],
      undefined,
      'Continue',
      IOS_TAB_FRAME,
      false,
      true,
    ),
  ).toMatchObject({ node: { index: 1 }, rect: { x: 20, y: 100, width: 220, height: 64 } });
});
