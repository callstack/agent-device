import { expect, test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotCaptureProvenance } from '@agent-device/contracts/snapshot-model';
import { buildSnapshotState } from './snapshot-state.ts';

/**
 * A Flutter screen on iOS at the top of its content (#4451): the scroll view and its content are
 * siblings, and the content below the fold keeps a zero-area frame at the origin.
 */
function scrolledOutButtonTree(): RawSnapshotNode[] {
  return [
    { index: 0, depth: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'ScrollView',
      rect: { x: 0, y: 118, width: 402, height: 756 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'StaticText',
      label: 'Tall block',
      rect: { x: 157, y: 546, width: 86, height: 27 },
    },
    {
      index: 3,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'View all',
      rect: { x: 0, y: 0, width: 0, height: 0 },
    },
    { index: 4, depth: 1, parentIndex: 0, type: 'StaticText', label: 'No frame' },
  ];
}

function hintsByNode(nodes: readonly RawSnapshotNode[]) {
  return nodes.map((node) => [node.label ?? node.type, node.presentationHints]);
}

const PROVENANCES: SnapshotCaptureProvenance[] = [
  { backend: 'xctest', producer: 'apple-runner' },
  { backend: 'android', producer: 'android-uiautomator' },
];

test.each(PROVENANCES)(
  'marks a node published with a zero-area rect as unmeasured ($producer)',
  (provenance) => {
    const state = buildSnapshotState({ nodes: scrolledOutButtonTree(), ...provenance }, undefined);

    expect(hintsByNode(state.nodes)).toEqual([
      ['Application', undefined],
      ['ScrollView', undefined],
      ['Tall block', undefined],
      ['View all', ['unmeasured']],
      // A node that reports no frame at all made no measurement to doubt.
      ['No frame', undefined],
    ]);
  },
);

test('a raw snapshot keeps the reported nodes without the unmeasured mark', () => {
  const state = buildSnapshotState(
    { nodes: scrolledOutButtonTree(), backend: 'xctest', producer: 'apple-runner' },
    { snapshotRaw: true },
  );

  expect(state.nodes.flatMap((node) => node.presentationHints ?? [])).toEqual([]);
});
