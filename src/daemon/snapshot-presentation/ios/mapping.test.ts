import { expect, test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { buildIosInteractiveSnapshotPresentation } from './index.ts';

test('publishes an exact representative for every semantic source index', () => {
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Application', rect: { x: 0, y: 0, width: 320, height: 640 } },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      identifier: 'semantic-wrapper',
      rect: { x: 20, y: 80, width: 120, height: 40 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Visible child',
      rect: { x: 20, y: 80, width: 120, height: 40 },
    },
    {
      index: 3,
      depth: 1,
      parentIndex: 0,
      type: 'StaticText',
      identifier: 'semantic-wrapper',
      label: 'Unrelated',
      rect: { x: 20, y: 180, width: 120, height: 40 },
    },
    {
      index: 4,
      depth: 1,
      parentIndex: 0,
      type: 'StaticText',
      identifier: 'shared-but-not-a-representative',
      rect: { x: 20, y: 240, width: 120, height: 40 },
    },
    {
      index: 5,
      depth: 2,
      parentIndex: 4,
      type: 'Other',
      identifier: 'shared-but-not-a-representative',
      rect: { x: 20, y: 240, width: 120, height: 40 },
    },
  ];

  const presentation = buildIosInteractiveSnapshotPresentation(nodes);

  expect([...presentation.presentedIndexesBySourceIndex]).toEqual([
    [0, [0]],
    [1, [1]],
    [2, [1]],
    [3, [2]],
    [4, [3]],
    [5, []],
  ]);
});
