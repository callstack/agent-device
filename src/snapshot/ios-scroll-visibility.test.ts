import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { projectIosScrollVisibility } from './ios-scroll-visibility.ts';
import { collapsedBoundaryNodes, elementSettingsNodes } from './ios-scroll-visibility.fixtures.ts';

test('projects collapsed offscreen descendants without hiding visible edge content', () => {
  const projection = projectIosScrollVisibility(elementSettingsNodes(), 'private-ax');

  assert.deepEqual(
    [...projection.hiddenIndexes].sort((a, b) => a - b),
    [5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.deepEqual(projection.hintsByScrollIndex.get(1), { above: false, below: true });
});

test('preserves co-located flattened controls away from the effective scroll edge', () => {
  const projection = projectIosScrollVisibility(elementSettingsNodes(), 'private-ax');

  assert.equal(projection.hiddenIndexes.has(15), false);
  assert.equal(projection.hiddenIndexes.has(16), false);
  assert.equal(projection.hiddenIndexes.has(17), false);
});

test('preserves three adjacent flattened controls below the collapsed-run threshold', () => {
  const nodes = collapsedBoundaryNodes({ candidateCount: 3, separator: false });
  assert.deepEqual(
    [...projectIosScrollVisibility(nodes, 'private-ax').hiddenIndexes].sort((a, b) => a - b),
    [2, 3],
  );
});

test('a visible structural separator preserves four following flattened controls', () => {
  const nodes = collapsedBoundaryNodes({ candidateCount: 4, separator: true });
  assert.deepEqual(
    [...projectIosScrollVisibility(nodes, 'private-ax').hiddenIndexes].sort((a, b) => a - b),
    [2, 3],
  );
});

test('projection is independent of backend node order', () => {
  const nodes = elementSettingsNodes();
  const shuffled = [...nodes].reverse();

  assert.deepEqual(
    [...projectIosScrollVisibility(shuffled, 'private-ax').hiddenIndexes].sort((a, b) => a - b),
    [5, 6, 7, 8, 9, 10, 11, 12],
  );
});

test('resolves deep non-scroll ancestry once per node', () => {
  let parentReads = 0;
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Application' },
    ...Array.from({ length: 128 }, (_, offset) => ({
      index: offset + 1,
      depth: offset + 1,
      type: 'Other',
      get parentIndex() {
        parentReads += 1;
        return offset;
      },
    })),
  ];

  projectIosScrollVisibility(nodes, 'tree');

  assert.ok(parentReads < nodes.length * 10, `read parentIndex ${parentReads} times`);
});

test('classifies a deep collapsed-cluster subtree in linear parent reads', () => {
  let parentReads = 0;
  const edge = { x: 0, y: 100, width: 100, height: 20 };
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Application' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Table',
      rect: { x: 0, y: 100, width: 300, height: 500 },
    },
    { index: 2, depth: 2, parentIndex: 1, type: 'Cell', rect: edge },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      rect: { x: 0, y: 2_000, width: 300, height: 40 },
    },
    { index: 4, depth: 3, parentIndex: 3, type: 'StaticText', rect: edge },
    { index: 5, depth: 3, parentIndex: 1, type: 'StaticText', rect: edge },
    ...Array.from({ length: 128 }, (_, offset) => ({
      index: offset + 6,
      depth: offset + 4,
      type: 'Other',
      rect: edge,
      get parentIndex() {
        parentReads += 1;
        return offset + 5;
      },
    })),
    { index: 134, depth: 3, parentIndex: 1, type: 'StaticText', rect: edge },
    { index: 135, depth: 3, parentIndex: 1, type: 'Switch', rect: edge },
    { index: 136, depth: 3, parentIndex: 1, type: 'StaticText', rect: edge },
  ];

  const projection = projectIosScrollVisibility(nodes, 'private-ax');

  assert.equal(projection.hiddenIndexes.has(136), true);
  assert.ok(parentReads < nodes.length * 20, `read parentIndex ${parentReads} times`);
});

test('projects reverse-ordered deep ancestry without exhausting the call stack', () => {
  const nodes: RawSnapshotNode[] = Array.from({ length: 12_000 }, (_, index) => ({
    index,
    depth: index,
    ...(index > 0 ? { parentIndex: index - 1 } : {}),
    type: index === 0 ? 'Application' : 'Other',
  })).reverse();

  assert.doesNotThrow(() => projectIosScrollVisibility(nodes, 'private-ax'));
});
