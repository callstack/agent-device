import assert from 'node:assert/strict';
import fc from 'fast-check';
import { test } from 'vitest';
import {
  distinctRectPairArb,
  PROPERTY_RUNS,
  scrollingContainerTypeArb,
} from '../__tests__/test-utils/property-arbitraries.ts';
import { makeSnapshotState } from '../__tests__/test-utils/snapshot-builders.ts';
import {
  classifyActionableTouchCandidates,
  createActionableTouchResolver,
  resolveActionableTouchResolution,
} from './interaction-targeting.ts';
import {
  ELEMENT14_DISTINCT_SUBTREE_NODES,
  EQUIVALENT_WRAPPER_CHAIN_NODES,
  INDEXED_PARITY_POLICY_NODES,
} from './interaction-targeting.fixtures.ts';

test('collapses one same-label wrapper chain to its shared actionable node', () => {
  const snapshot = makeSnapshotState(EQUIVALENT_WRAPPER_CHAIN_NODES);

  const result = classifyActionableTouchCandidates(snapshot.nodes, snapshot.nodes);

  assert.equal(result.kind, 'equivalent');
  if (result.kind === 'equivalent') assert.equal(result.node.index, 1);
});

test('rejects same-label candidates in distinct subtrees even when geometry ranks one winner', () => {
  const snapshot = makeSnapshotState(ELEMENT14_DISTINCT_SUBTREE_NODES);
  const matches = snapshot.nodes.slice(1);

  const result = classifyActionableTouchCandidates(snapshot.nodes, matches);

  assert.equal(result.kind, 'ambiguous');
  if (result.kind === 'ambiguous') {
    assert.deepEqual(
      result.candidates.map((node) => node.index),
      [1, 2, 3, 4],
    );
  }
});

test('promotes static text inside a hittable row to the row', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeCell',
      label: 'Account row',
      rect: { x: 10, y: 20, width: 300, height: 60 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeStaticText',
      label: 'Account',
      rect: { x: 24, y: 32, width: 80, height: 20 },
      hittable: false,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[1]!);

  assert.equal(resolution.reason, 'hittable-ancestor');
  assert.equal(resolution.node.label, 'Account row');
});

test.each([
  'XCUIElementTypeScrollView',
  'XCUIElementTypeTable',
  'XCUIElementTypeCollectionView',
  'android.widget.ListView',
  'androidx.recyclerview.widget.RecyclerView',
])('does not promote a labeled region to its %s container', (containerType) => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: containerType,
      rect: { x: 0, y: 116, width: 402, height: 37 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeOther',
      identifier: 'feed-tab-1',
      label: 'Second tab',
      rect: { x: 201.67, y: 110, width: 194.33, height: 43 },
      hittable: false,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[1]!);

  assert.equal(resolution.reason, 'overly-broad-ancestor');
  assert.equal(resolution.node.label, 'Second tab');
});

test('never promotes a differently sized or positioned target to a scrolling container', () => {
  fc.assert(
    fc.property(scrollingContainerTypeArb, distinctRectPairArb, (containerType, rects) => {
      const snapshot = makeSnapshotState([
        {
          index: 0,
          depth: 0,
          type: containerType,
          rect: rects.ancestor,
          hittable: true,
        },
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'XCUIElementTypeOther',
          label: 'Virtual target',
          rect: rects.target,
          hittable: false,
        },
      ]);

      const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[1]!);

      assert.equal(resolution.reason, 'overly-broad-ancestor');
      assert.equal(resolution.node.label, 'Virtual target');
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test('prefers same-rect hittable descendants over semantic targets', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeButton',
      label: 'Profile',
      rect: { x: 30, y: 40, width: 120, height: 50 },
      hittable: false,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeImage',
      identifier: 'profile-hit-area',
      rect: { x: 30, y: 40, width: 120, height: 50 },
      hittable: true,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[0]!);

  assert.equal(resolution.reason, 'same-rect-descendant');
  assert.equal(resolution.node.identifier, 'profile-hit-area');
});

test('prevents full-screen window-like ancestors from stealing taps', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeApplication',
      label: 'Example',
      rect: { x: 0, y: 0, width: 390, height: 844 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeStaticText',
      label: 'Status',
      rect: { x: 24, y: 72, width: 80, height: 24 },
      hittable: false,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[1]!);

  assert.equal(resolution.reason, 'overly-broad-ancestor');
  assert.equal(resolution.node.label, 'Status');
});

test('falls back to the original node when no usable touch target exists', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeOther',
      label: 'Virtual item',
      hittable: false,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[0]!);

  assert.equal(resolution.reason, 'original');
  assert.equal(resolution.node.label, 'Virtual item');
});

test('the batch resolver preserves every actionability policy branch', () => {
  const snapshot = makeSnapshotState(INDEXED_PARITY_POLICY_NODES);
  const resolveTouch = createActionableTouchResolver(snapshot.nodes);

  const unindexed = snapshot.nodes.map((node) =>
    resolveActionableTouchResolution(snapshot.nodes, node),
  );
  const indexed = snapshot.nodes.map(resolveTouch);

  assert.deepEqual(indexed, unindexed);
  assert.deepEqual(
    indexed.map((resolution) => [resolution.node.index, resolution.reason]),
    [
      [0, 'hittable-ancestor'],
      [2, 'same-rect-descendant'],
      [2, 'hittable-ancestor'],
      [3, 'semantic-target'],
      [4, 'semantic-target'],
      [4, 'hittable-ancestor'],
      [6, 'hittable-ancestor'],
      [7, 'overly-broad-ancestor'],
      [8, 'covered'],
      [9, 'original'],
      [10, 'overly-broad-ancestor'],
    ],
  );
});
