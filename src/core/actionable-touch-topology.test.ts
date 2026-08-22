import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '../__tests__/test-utils/snapshot-builders.ts';
import { buildActionableTouchTopology } from './actionable-touch-topology.ts';

/**
 * Non-contiguous indexes, two parents, and every root vocabulary the canonical
 * predicate recognizes — the three questions a ranking pass asks the tree.
 */
const MIXED_TOPOLOGY_NODES = [
  {
    index: 10,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: true,
  },
  {
    index: 20,
    depth: 1,
    parentIndex: 10,
    type: 'AXUnknown',
    role: 'AXWindow',
    rect: { x: 0, y: 0, width: 390, height: 400 },
    hittable: true,
  },
  {
    index: 30,
    depth: 1,
    parentIndex: 10,
    type: 'XCUIElementTypeOther',
    subrole: 'AXFloatingWindow',
    rect: { x: 10, y: 10, width: 100, height: 100 },
    hittable: false,
  },
  {
    index: 40,
    depth: 2,
    parentIndex: 20,
    type: 'XCUIElementTypeButton',
    label: 'Save',
    rect: { x: 20, y: 20, width: 80, height: 30 },
    hittable: true,
  },
  {
    index: 50,
    depth: 2,
    parentIndex: 20,
    type: 'XCUIElementTypeStaticText',
    label: 'Saved',
    rect: { x: 20, y: 60, width: 80, height: 20 },
    hittable: false,
  },
  // A viewport root with an unusable rect: the same drop the per-candidate
  // filter/map chain performed, so an indexed pass cannot start measuring
  // against NaN geometry.
  {
    index: 60,
    depth: 1,
    parentIndex: 10,
    type: 'XCUIElementTypeWindow',
    rect: { x: Number.NaN, y: 0, width: 390, height: 844 },
    hittable: true,
  },
];

test('indexes every node by its snapshot index, not its array position', () => {
  const snapshot = makeSnapshotState(MIXED_TOPOLOGY_NODES);

  const topology = buildActionableTouchTopology(snapshot.nodes);

  assert.deepEqual([...topology.nodesByIndex.keys()], [10, 20, 30, 40, 50, 60]);
  assert.strictEqual(topology.nodesByIndex.get(40), snapshot.nodes[3]);
});

test('groups children under each parent index in input order', () => {
  const snapshot = makeSnapshotState(MIXED_TOPOLOGY_NODES);

  const topology = buildActionableTouchTopology(snapshot.nodes);

  assert.deepEqual(
    topology.childrenByParentIndex.get(10)?.map((node) => node.index),
    [20, 30, 60],
  );
  assert.deepEqual(
    topology.childrenByParentIndex.get(20)?.map((node) => node.index),
    [40, 50],
  );
  assert.equal(topology.childrenByParentIndex.get(40), undefined);
});

test('collects canonical viewport-root rects from type, role, and subrole', () => {
  const snapshot = makeSnapshotState(MIXED_TOPOLOGY_NODES);

  const topology = buildActionableTouchTopology(snapshot.nodes);

  assert.deepEqual(topology.viewportRootRects, [
    { x: 0, y: 0, width: 390, height: 844 },
    { x: 0, y: 0, width: 390, height: 400 },
    { x: 10, y: 10, width: 100, height: 100 },
  ]);
});
