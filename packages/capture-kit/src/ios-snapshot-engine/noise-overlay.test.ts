import { expect, test } from 'vitest';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { buildIosInteractiveSnapshotPresentation } from './semantic-index.ts';

function buildSnapshotState(nodes: RawSnapshotNode[]) {
  return attachRefs(buildIosInteractiveSnapshotPresentation(nodes).nodes);
}

test('the wrapper pass collapses the full-screen parent of a count-badge warning banner', () => {
  // From two entries up, the banner's label starts with the LogBox entry count instead of `!`, so
  // the wrapper pass reads the banner by LogBox's placement rather than by its label.
  const nodes: RawSnapshotNode[] = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Agent Device Tester',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: '20, Failed to fetch',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: '20, Failed to fetch',
      rect: { x: 10, y: 786.666, width: 382, height: 67.333 },
    },
  ];

  expect(
    buildSnapshotState(nodes).map((node) => [
      node.type,
      node.label,
      node.rect?.y,
      node.parentIndex,
    ]),
  ).toEqual([
    ['Application', 'Agent Device Tester', 0, undefined],
    ['Other', '20, Failed to fetch', 786.666, 0],
  ]);
});
