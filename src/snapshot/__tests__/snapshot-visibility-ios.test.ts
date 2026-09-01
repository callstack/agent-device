import { expect, test } from 'vitest';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { buildSnapshotVisibility } from '../snapshot-visibility.ts';
import { presentIosInteractiveSnapshot } from '@agent-device/capture-kit/ios-snapshot-engine';

function buildSnapshotState(data: { nodes?: RawSnapshotNode[]; backend?: 'xctest' }) {
  return {
    nodes: attachRefs(presentIosInteractiveSnapshot(data.nodes ?? [])),
    backend: data.backend,
    createdAt: Date.now(),
  };
}

test('buildSnapshotVisibility keeps iOS hidden-below hints after row collapse', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Table',
      label: 'Settings',
      rect: { x: 0, y: 100, width: 402, height: 300 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Below',
      rect: { x: 20, y: 430, width: 362, height: 53 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 4,
      type: 'Button',
      label: 'Below',
      rect: { x: 20, y: 430, width: 362, height: 53 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });
  const visibility = buildSnapshotVisibility({ nodes: state.nodes, backend: state.backend });

  expect(visibility.reasons).toContain('scroll-hidden-below');
  expect(visibility.reasons).not.toContain('scroll-hidden-above');
});

test('buildSnapshotState transfers iOS scroll indicator values to scroll containers', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Vertical scroll bar, 2 pages',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'CollectionView',
      label: 'Vertical scroll bar, 2 pages',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Cell',
      label: 'General',
      rect: { x: 16, y: 293, width: 370, height: 52 },
    },
    {
      index: 4,
      depth: 4,
      parentIndex: 3,
      type: 'Button',
      label: 'General',
      rect: { x: 16, y: 293, width: 370, height: 52 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 2,
      type: 'Other',
      label: 'Vertical scroll bar, 2 pages',
      value: '0%',
      rect: { x: 369, y: 116, width: 30, height: 672 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label])).toEqual([
    ['Application', 'Settings'],
    ['CollectionView', 'Vertical scroll bar, 2 pages'],
    ['Cell', 'General'],
  ]);
  expect(state.nodes[1]?.hiddenContentAbove).toBeUndefined();
  expect(state.nodes[1]?.hiddenContentBelow).toBe(true);
  expect(state.nodes[1]?.rect).toEqual({ x: 0, y: 116, width: 402, height: 672 });
});

test('buildSnapshotVisibility keeps iOS hidden-above hints after row collapse', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Table',
      label: 'Settings',
      rect: { x: 0, y: 100, width: 402, height: 300 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Above',
      rect: { x: 20, y: 20, width: 362, height: 53 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'Above',
      rect: { x: 20, y: 20, width: 362, height: 53 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 4,
      type: 'Button',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });
  const visibility = buildSnapshotVisibility({ nodes: state.nodes, backend: state.backend });

  expect(visibility.reasons).toContain('scroll-hidden-above');
  expect(visibility.reasons).not.toContain('scroll-hidden-below');
});

test('buildSnapshotState transfers bottomed iOS scroll indicators without hidden-below', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Table',
      label: 'Settings',
      rect: { x: 0, y: 100, width: 402, height: 300 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Vertical scroll bar, 2 pages',
      value: '100%',
      rect: { x: 369, y: 116, width: 30, height: 672 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });
  const visibility = buildSnapshotVisibility({ nodes: state.nodes, backend: state.backend });

  expect(state.nodes[1]?.hiddenContentAbove).toBe(true);
  expect(state.nodes[1]?.hiddenContentBelow).toBeUndefined();
  expect(visibility.reasons).toContain('scroll-hidden-above');
  expect(visibility.reasons).not.toContain('scroll-hidden-below');
});
