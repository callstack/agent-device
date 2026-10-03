import assert from 'node:assert/strict';
import fc from 'fast-check';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  distinctRectPairArb,
  makeSnapshotState,
  PROPERTY_RUNS,
  scrollingContainerTypeArb,
} from './snapshot-geometry.fixtures.ts';
import {
  classifyActionableTouchCandidates,
  createActionableTouchResolver,
  resolveActionableTouchResolution,
  resolveUnverifiedWrapperControl,
} from './interaction-targeting.ts';
import {
  ELEMENT14_DISTINCT_SUBTREE_NODES,
  EQUIVALENT_WRAPPER_CHAIN_NODES,
  INDEXED_PARITY_POLICY_NODES,
  TWO_ACTIONABLE_WRAPPER_CHAIN_NODES,
  UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES,
} from './interaction-targeting.fixtures.ts';

test('collapses one same-label wrapper chain to its shared actionable node', () => {
  const snapshot = makeSnapshotState(EQUIVALENT_WRAPPER_CHAIN_NODES);

  const result = classifyActionableTouchCandidates(
    snapshot.nodes,
    snapshot.nodes.filter((node) => node.label === 'Chat'),
  );

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
      depth: 1,
      parentIndex: 2,
      type: 'XCUIElementTypeCell',
      label: 'Account row',
      rect: { x: 10, y: 20, width: 300, height: 60 },
      hittable: true,
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'XCUIElementTypeStaticText',
      label: 'Account',
      rect: { x: 24, y: 32, width: 80, height: 20 },
      hittable: false,
    },
    {
      index: 2,
      depth: 0,
      type: 'XCUIElementTypeApplication',
      rect: { x: 0, y: 0, width: 390, height: 844 },
      hittable: true,
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

test('prevents a full-screen ancestor from stealing taps in a rootless Android-shaped tree', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 1080, height: 2400 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.TextView',
      label: 'Inbox',
      rect: { x: 24, y: 200, width: 160, height: 64 },
      hittable: false,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[1]!);

  assert.equal(resolution.reason, 'overly-broad-ancestor');
  assert.equal(resolution.node.label, 'Inbox');
});

test('applies the rootless viewport fallback without platform-shaped node types', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Container',
      rect: { x: 0, y: 0, width: 1080, height: 2400 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Label',
      label: 'Inbox',
      rect: { x: 24, y: 200, width: 160, height: 64 },
      hittable: false,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[1]!);

  assert.equal(resolution.reason, 'overly-broad-ancestor');
  assert.equal(resolution.node.label, 'Inbox');
});

test('keeps a rootless ancestor when its rectangle matches the target', () => {
  const targetRect = { x: 24, y: 200, width: 160, height: 64 };
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Container',
      rect: targetRect,
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Label',
      label: 'Inbox',
      rect: targetRect,
      hittable: false,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[1]!);

  assert.equal(resolution.reason, 'hittable-ancestor');
  assert.equal(resolution.node.index, 0);
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

test('collapses a wrapper chain whose hittability is unverified and whose rects differ sub-pixel', () => {
  const snapshot = makeSnapshotState(UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES);

  const result = classifyActionableTouchCandidates(
    snapshot.nodes,
    snapshot.nodes.filter((node) => node.identifier === 'scoring_home_button'),
  );

  assert.equal(result.kind, 'equivalent');
  if (result.kind === 'equivalent') {
    assert.equal(result.node.index, 1);
    assert.equal(result.node.type, 'XCUIElementTypeButton');
  }
});

test('keeps a wrapper chain that reports hittability evidence on the existing rules', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 1,
      type: 'XCUIElementTypeOther',
      identifier: 'profile',
      rect: { x: 20, y: 63, width: 36, height: 36 },
      hittable: false,
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      identifier: 'profile',
      rect: { x: 20.666666666666668, y: 63, width: 35, height: 36 },
      hittable: true,
    },
  ]);

  const result = classifyActionableTouchCandidates(snapshot.nodes, snapshot.nodes);

  assert.equal(result.kind, 'ambiguous');
  if (result.kind === 'ambiguous')
    assert.deepEqual(
      result.candidates.map((node) => node.index),
      [0, 1],
    );
});

test('refuses a wrapper chain whose rects differ beyond sub-pixel slack', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 1,
      type: 'XCUIElementTypeOther',
      identifier: 'profile',
      rect: { x: 20, y: 63, width: 60, height: 36 },
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      identifier: 'profile',
      rect: { x: 20, y: 63, width: 36, height: 36 },
    },
  ]);

  assert.equal(classifyActionableTouchCandidates(snapshot.nodes, snapshot.nodes).kind, 'ambiguous');
});

test('refuses a wrapper chain of two real controls that share one rect', () => {
  // A cell and the button inside it share an identifier and their rects agree
  // within slack. Both are actionable, so collapsing to the descendant would
  // silently press the wrong control; the ambiguity refusal must survive.
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 1,
      type: 'XCUIElementTypeCell',
      identifier: 'row_action',
      rect: { x: 20, y: 63, width: 36, height: 36 },
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      identifier: 'row_action',
      rect: { x: 20.5, y: 63, width: 35, height: 36 },
    },
  ]);

  assert.equal(classifyActionableTouchCandidates(snapshot.nodes, snapshot.nodes).kind, 'ambiguous');
});

test('refuses a wrapper chain whose deepest candidate is not a touch target', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 1,
      type: 'XCUIElementTypeOther',
      identifier: 'banner',
      rect: { x: 20, y: 63, width: 36, height: 36 },
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'XCUIElementTypeOther',
      identifier: 'banner',
      rect: { x: 20, y: 63, width: 36, height: 36 },
    },
  ]);

  assert.equal(classifyActionableTouchCandidates(snapshot.nodes, snapshot.nodes).kind, 'ambiguous');
});

/**
 * The candidate set a uniqueness read hands the rule: every node reporting one
 * identifier. The acting classifier refuses a set that is not one chain before
 * it asks, so the rule carries its own chain check for the reads that ask
 * directly.
 */
function identifierReports(
  snapshot: ReturnType<typeof makeSnapshotState>,
  identifier: string,
): SnapshotNode[] {
  return snapshot.nodes.filter((node) => node.identifier === identifier);
}

test('resolves the control of one ancestry chain through the rule on its own', () => {
  const snapshot = makeSnapshotState(UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES);
  const reports = identifierReports(snapshot, 'scoring_home_button');
  assert.deepEqual(
    reports.map((node) => node.type),
    ['XCUIElementTypeOther', 'XCUIElementTypeButton'],
  );

  const control = resolveUnverifiedWrapperControl(snapshot.nodes, reports);

  assert.equal(control?.type, 'XCUIElementTypeButton');
  assert.equal(control?.index, 1);
});

test('refuses a candidate set that is one report, not a pair to collapse', () => {
  // Reachable through the rect-requiring rows: a refused set can hold a single
  // candidate once matches without a rect are dropped.
  const snapshot = makeSnapshotState(UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES);
  const reports = identifierReports(snapshot, 'scoring_home_button');

  assert.equal(resolveUnverifiedWrapperControl(snapshot.nodes, [reports[1]!]), null);
});

test('refuses one ancestry chain of two real controls through the rule on its own', () => {
  const snapshot = makeSnapshotState(TWO_ACTIONABLE_WRAPPER_CHAIN_NODES);
  const reports = identifierReports(snapshot, 'profile');
  assert.deepEqual(
    reports.map((node) => node.type),
    ['XCUIElementTypeCell', 'XCUIElementTypeButton'],
  );

  assert.equal(resolveUnverifiedWrapperControl(snapshot.nodes, reports), null);
});

test('refuses reports that sit in two separate ancestry chains', () => {
  // No hittability evidence, rects agree within slack, one deepest control under
  // non-actionable wrappers — every condition but the chain holds. Two subtrees
  // each reporting one control are two controls, not one reported twice.
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 2,
      parentIndex: 2,
      type: 'XCUIElementTypeOther',
      identifier: 'profile',
      rect: { x: 20, y: 63, width: 36, height: 36 },
    },
    {
      index: 1,
      depth: 3,
      parentIndex: 3,
      type: 'XCUIElementTypeButton',
      identifier: 'profile',
      rect: { x: 20.666666666666668, y: 63, width: 35, height: 36 },
    },
    { index: 2, depth: 1, parentIndex: 4, type: 'XCUIElementTypeGroup' },
    { index: 3, depth: 2, parentIndex: 4, type: 'XCUIElementTypeGroup' },
    {
      index: 4,
      depth: 0,
      type: 'XCUIElementTypeApplication',
      rect: { x: 0, y: 0, width: 393, height: 852 },
    },
  ]);
  const reports = identifierReports(snapshot, 'profile');
  assert.deepEqual(
    reports.map((node) => node.type),
    ['XCUIElementTypeOther', 'XCUIElementTypeButton'],
  );

  assert.equal(resolveUnverifiedWrapperControl(snapshot.nodes, reports), null);
  assert.equal(classifyActionableTouchCandidates(snapshot.nodes, reports).kind, 'ambiguous');
});
