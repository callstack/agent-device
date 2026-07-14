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

test('target ranking preserves contextual duplicate ordering for ordinary indexes', () => {
  expect(
    selectContextualDuplicate({
      contextIndex: 100,
      earlierContainerIndex: 90,
      laterContainerIndex: 110,
    }),
  ).toMatchObject({ node: { index: 111 } });
});

test('target ranking keeps a distant later duplicate ahead of a negative-index duplicate', () => {
  expect(
    selectContextualDuplicate({
      contextIndex: 0,
      earlierContainerIndex: -1,
      laterContainerIndex: 100_002,
    }),
  ).toMatchObject({ node: { index: 100_003 } });
});

function selectContextualDuplicate(options: {
  contextIndex: number;
  earlierContainerIndex: number;
  laterContainerIndex: number;
}) {
  const snapshot = makeSnapshot([
    {
      index: options.contextIndex,
      type: 'StaticText',
      label: 'Context',
      rect: { x: 0, y: 600, width: 120, height: 40 },
    },
    {
      index: options.earlierContainerIndex,
      type: 'ScrollView',
      rect: { x: 0, y: 0, width: 300, height: 400 },
    },
    {
      index: options.earlierContainerIndex - 1,
      parentIndex: options.earlierContainerIndex,
      type: 'StaticText',
      label: 'Save',
      rect: { x: 24, y: 100, width: 120, height: 44 },
    },
    {
      index: options.laterContainerIndex,
      type: 'ScrollView',
      rect: { x: 0, y: 0, width: 300, height: 400 },
    },
    {
      index: options.laterContainerIndex + 1,
      parentIndex: options.laterContainerIndex,
      type: 'StaticText',
      label: 'Save',
      rect: { x: 24, y: 100, width: 120, height: 44 },
    },
  ]);
  const context = snapshot.nodes[0]!;
  const candidates = snapshot.nodes.filter((node) => node.label === 'Save');

  return selectMaestroSnapshotMatch(
    snapshot.nodes,
    candidates,
    undefined,
    'Save',
    IOS_TAB_FRAME,
    false,
    false,
    { node: context, rect: context.rect! },
  );
}
