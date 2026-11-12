import { expect, test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { buildIosInteractiveSnapshotPresentation } from './semantic-index.ts';

const FULL_SCREEN = { x: 0, y: 0, width: 402, height: 874 };
const SETTINGS_BACK_BUTTON = {
  type: 'Button',
  label: 'Settings',
  rect: { x: 16, y: 62, width: 44, height: 44 },
};

function presented(nodes: RawSnapshotNode[]) {
  return buildIosInteractiveSnapshotPresentation(nodes).nodes.map((node) => [
    node.type,
    node.label,
    node.parentIndex,
  ]);
}

test('a SwiftUI app root that shares the back button label stays the root', () => {
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'Other',
      subrole: 'UIApplication',
      label: 'Settings',
      rect: FULL_SCREEN,
    },
    { index: 1, depth: 1, parentIndex: 0, ...SETTINGS_BACK_BUTTON },
  ];

  expect(presented(nodes)).toEqual([
    ['Other', 'Settings', undefined],
    ['Button', 'Settings', 0],
  ]);
});

test('a SwiftUI app root that shares its list label stays the root', () => {
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'Other',
      subrole: 'UIApplication',
      label: 'Notes',
      rect: FULL_SCREEN,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'CollectionView',
      label: 'Notes',
      rect: FULL_SCREEN,
    },
  ];

  expect(presented(nodes)).toEqual([
    ['Other', 'Notes', undefined],
    ['CollectionView', 'Notes', 0],
  ]);
});

test('a wrapper that shares its list label still collapses', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'App', rect: FULL_SCREEN },
    { index: 1, depth: 1, parentIndex: 0, type: 'Other', label: 'Notes', rect: FULL_SCREEN },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'CollectionView',
      label: 'Notes',
      rect: FULL_SCREEN,
    },
  ];

  expect(presented(nodes)).toEqual([
    ['Application', 'App', undefined],
    ['CollectionView', 'Notes', 0],
  ]);
});

test('a full-screen wrapper that shares its button label still collapses', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'App', rect: FULL_SCREEN },
    { index: 1, depth: 1, parentIndex: 0, type: 'Other', label: 'Settings', rect: FULL_SCREEN },
    { index: 2, depth: 2, parentIndex: 1, ...SETTINGS_BACK_BUTTON },
  ];

  expect(presented(nodes)).toEqual([
    ['Application', 'App', undefined],
    ['Button', 'Settings', 0],
  ]);
});
