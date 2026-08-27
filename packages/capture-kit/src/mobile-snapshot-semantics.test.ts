import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildMobileSnapshotPresentation,
  classifyOffscreenScrollDirection,
  isConfirmedOnScreenProbe,
} from './mobile-snapshot-semantics.ts';
import { isNodeVisibleInEffectiveViewport } from '@agent-device/contracts/snapshot';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';

test('mobile presentation keeps only visible nodes and adds off-screen summary fallback', () => {
  const nodes: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Visible action',
      rect: { x: 20, y: 140, width: 160, height: 44 },
      hittable: true,
    },
    {
      ref: 'e3',
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Later action',
      rect: { x: 20, y: 1100, width: 160, height: 44 },
      hittable: true,
    },
  ];

  const presentation = buildMobileSnapshotPresentation(nodes);
  assert.equal(presentation.nodes.length, 2);
  assert.equal(presentation.hiddenCount, 1);
  assert.deepEqual(presentation.summaryLines, [
    '[off-screen below] 1 interactive item: "Later action"',
  ]);
});

test('mobile presentation assigns hidden content hints to visible scroll containers', () => {
  const nodes: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.ScrollView',
      label: 'Messages',
      rect: { x: 0, y: 140, width: 390, height: 500 },
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'Older',
      rect: { x: 20, y: 60, width: 350, height: 44 },
      hittable: true,
    },
    {
      ref: 'e4',
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'Visible',
      rect: { x: 20, y: 260, width: 350, height: 44 },
      hittable: true,
    },
    {
      ref: 'e5',
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'Newer',
      rect: { x: 20, y: 680, width: 350, height: 44 },
      hittable: true,
    },
  ];

  const presentation = buildMobileSnapshotPresentation(nodes);
  const container = presentation.nodes.find((node) => node.index === 1);
  assert.equal(container?.hiddenContentAbove, true);
  assert.equal(container?.hiddenContentBelow, true);
  assert.deepEqual(presentation.summaryLines, []);
});

test('mobile presentation keeps fixed bottom controls after long visible scroll surfaces', () => {
  const nodes: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'ScrollView',
      label: 'Contacts',
      rect: { x: 0, y: 116, width: 402, height: 675 },
    },
    ...Array.from({ length: 20 }, (_, offset): SnapshotNode => {
      const index = 3 + offset;
      return {
        ref: `e${index + 1}`,
        index,
        depth: 3,
        parentIndex: 2,
        type: 'StaticText',
        label: `Contact ${offset}`,
        rect: { x: 52, y: 132 + offset * 64, width: 160, height: 18 },
      };
    }),
    {
      ref: 'e24',
      index: 23,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Article, unselected',
      identifier: 'article',
      rect: { x: 0, y: 791, width: 101, height: 49 },
      hittable: false,
    },
    {
      ref: 'e25',
      index: 24,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Contacts, selected',
      identifier: 'contacts',
      rect: { x: 201, y: 791, width: 101, height: 49 },
      selected: true,
      hittable: false,
    },
    {
      ref: 'e26',
      index: 25,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Albums, unselected',
      identifier: 'albums',
      rect: { x: 302, y: 791, width: 100, height: 49 },
      hittable: false,
    },
  ];

  const presentation = buildMobileSnapshotPresentation(nodes);
  const identifiers = new Set(presentation.nodes.map((node) => node.identifier).filter(Boolean));
  assert.deepEqual([...identifiers].sort(), ['albums', 'article', 'contacts']);
  assert.equal(
    presentation.nodes.some((node) => node.label === 'Contact 19'),
    false,
  );
  assert.equal(presentation.nodes.find((node) => node.index === 2)?.hiddenContentBelow, true);
});

test('mobile presentation handles zero-width viewport gracefully', () => {
  const nodes: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 0, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Action',
      rect: { x: 20, y: 140, width: 160, height: 44 },
      hittable: true,
    },
  ];

  const presentation = buildMobileSnapshotPresentation(nodes);
  // With a degenerate viewport, nodes should still be included rather than dropped
  assert.ok(presentation.nodes.length > 0);
});

test('mobile presentation handles zero-height viewport gracefully', () => {
  const nodes: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 390, height: 0 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Action',
      rect: { x: 20, y: 140, width: 160, height: 44 },
      hittable: true,
    },
  ];

  const presentation = buildMobileSnapshotPresentation(nodes);
  assert.ok(presentation.nodes.length > 0);
});

test('mobile presentation handles nodes with negative coordinates', () => {
  const nodes: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Off left',
      rect: { x: -200, y: 200, width: 160, height: 44 },
      hittable: true,
    },
    {
      ref: 'e3',
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Visible',
      rect: { x: 20, y: 200, width: 160, height: 44 },
      hittable: true,
    },
  ];

  const presentation = buildMobileSnapshotPresentation(nodes);
  const visibleLabels = presentation.nodes.filter((n) => n.label).map((n) => n.label);
  assert.ok(visibleLabels.includes('Visible'));
});

test('visibility is true for node at exact viewport boundary', () => {
  const nodes: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Edge',
      // Bottom edge of node touches top of viewport — 1 px overlap
      rect: { x: 20, y: -43, width: 160, height: 44 },
      hittable: true,
    },
  ];

  // Node overlaps viewport by 1 px at the top edge — should be considered visible
  assert.equal(isNodeVisibleInEffectiveViewport(nodes[1]!, nodes), true);
});

test('visibility is false for node just outside viewport boundary', () => {
  const nodes: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Outside',
      // Entirely above viewport — y + height = -1, which is above the viewport top
      rect: { x: 20, y: -45, width: 160, height: 44 },
      hittable: true,
    },
  ];

  assert.equal(isNodeVisibleInEffectiveViewport(nodes[1]!, nodes), false);
});

function windowRoot(): SnapshotNode {
  return {
    ref: 'e1',
    index: 0,
    depth: 0,
    type: 'Window',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };
}

test('classifyOffscreenScrollDirection names the reveal direction for a fully scrolled-out item', () => {
  const below: SnapshotNode[] = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Far below',
      rect: { x: 20, y: 1200, width: 120, height: 44 },
      hittable: true,
    },
  ];
  assert.equal(classifyOffscreenScrollDirection(below[1]!, below), 'down');

  const above: SnapshotNode[] = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Far above',
      rect: { x: 20, y: -100, width: 120, height: 44 },
      hittable: true,
    },
  ];
  assert.equal(classifyOffscreenScrollDirection(above[1]!, above), 'up');
});

test('classifyOffscreenScrollDirection returns null for an on-screen node', () => {
  const nodes: SnapshotNode[] = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Visible',
      rect: { x: 20, y: 40, width: 120, height: 44 },
      hittable: true,
    },
  ];
  assert.equal(classifyOffscreenScrollDirection(nodes[1]!, nodes), null);
});

test('classifyOffscreenScrollDirection resolves a partial clip whose center is past the viewport (#1366)', () => {
  // The rect still OVERLAPS the root viewport (top edge inside), so the rect-vs-
  // viewport form returns null — but the tap-point center sits below the bottom
  // edge, which is exactly what isNodeVisibleOnScreen rejects. Direction must be down.
  const nodes: SnapshotNode[] = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Straddling the bottom edge',
      rect: { x: 20, y: 790, width: 120, height: 44 },
      hittable: true,
    },
  ];
  // Sanity: this node is genuinely rejected by the interaction visibility guard.
  assert.equal(isNodeVisibleInEffectiveViewport(nodes[1]!, nodes), true);
  assert.equal(classifyOffscreenScrollDirection(nodes[1]!, nodes), 'down');
});

test('classifyOffscreenScrollDirection resolves a child inside an off-screen scrollable ancestor (#1366)', () => {
  // Closed drawer: the child overlaps its own ScrollView (so boundary 1 passes),
  // but the container is off the root viewport to the left, so the child's center
  // is outside the root frame. Direction must come from the root boundary: left.
  const nodes: SnapshotNode[] = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'ScrollView',
      label: 'Drawer',
      rect: { x: -400, y: 0, width: 400, height: 800 },
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Drawer action',
      rect: { x: -380, y: 300, width: 200, height: 44 },
      hittable: true,
    },
  ];
  // Boundary 1 passes (child overlaps its container); the root boundary fails.
  assert.equal(isNodeVisibleInEffectiveViewport(nodes[2]!, nodes), true);
  assert.equal(classifyOffscreenScrollDirection(nodes[2]!, nodes), 'left');
});

test('mobile presentation infers hidden content from vertical scroll indicator value at top', () => {
  const nodes: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'CollectionView',
      label: 'Vertical scroll bar, 2 pages',
      rect: { x: 0, y: 80, width: 390, height: 680 },
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Vertical scroll bar, 2 pages',
      value: '0%',
      rect: { x: 360, y: 96, width: 20, height: 640 },
    },
  ];

  const presentation = buildMobileSnapshotPresentation(nodes);
  const container = presentation.nodes.find((node) => node.index === 1);
  assert.equal(container?.hiddenContentAbove, undefined);
  assert.equal(container?.hiddenContentBelow, true);
});

test('mobile presentation infers hidden content from vertical scroll indicator value in middle', () => {
  const nodes: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'CollectionView',
      label: 'Vertical scroll bar, 2 pages',
      rect: { x: 0, y: 80, width: 390, height: 680 },
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Vertical scroll bar, 2 pages',
      value: '48%',
      rect: { x: 360, y: 96, width: 20, height: 640 },
    },
  ];

  const presentation = buildMobileSnapshotPresentation(nodes);
  const container = presentation.nodes.find((node) => node.index === 1);
  assert.equal(container?.hiddenContentAbove, true);
  assert.equal(container?.hiddenContentBelow, true);
});

test('mobile presentation does not let contradictory scroll indicator add hidden content below', () => {
  const nodes: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'ScrollView',
      label: 'List of chat messages',
      rect: { x: 0, y: 135, width: 402, height: 617 },
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Older message',
      rect: { x: 0, y: -120, width: 402, height: 56 },
    },
    {
      ref: 'e4',
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Latest visible message',
      rect: { x: 0, y: 696, width: 402, height: 56 },
    },
    {
      ref: 'e5',
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Vertical scroll bar, 3 pages',
      value: '0%',
      rect: { x: 369, y: 135, width: 30, height: 617 },
    },
  ];

  const presentation = buildMobileSnapshotPresentation(nodes);
  const container = presentation.nodes.find((node) => node.index === 1);
  assert.equal(container?.hiddenContentAbove, true);
  assert.equal(container?.hiddenContentBelow, undefined);
});

// #1542: isConfirmedOnScreenProbe is the pure geometry boundary the off-screen
// refusal double-check's direct probe (src/daemon/offscreen-target-probe.ts)
// reduces its confirm/don't-confirm decision to, once it has a fresh,
// tree-independent read of the target. Each branch below is proved with a
// counterfactual per docs/agents/testing.md — see the comment on each test
// for the one-line mutation that turns it red.

const CONFIRM_PROBE_ROOT_VIEWPORT: Rect = { x: 0, y: 0, width: 400, height: 800 };

test('isConfirmedOnScreenProbe: hittable + inside the root viewport -> confirmed', () => {
  const probe = { rect: { x: 100, y: 100, width: 50, height: 50 }, hittable: true };
  assert.equal(isConfirmedOnScreenProbe(probe, CONFIRM_PROBE_ROOT_VIEWPORT), true);
});

test('isConfirmedOnScreenProbe: inside the viewport but NOT hittable -> not confirmed', () => {
  // Counterfactual ("ignore hittable"): change the function to
  // `return isTapPointInsideViewport(probe.rect, rootViewport);`, dropping
  // the hittable check entirely. This test goes red — it pins that a probe
  // reporting a plausible rect but a live "not hittable" state (occluded,
  // disabled, or otherwise not actually tappable) must not rescue.
  const probe = { rect: { x: 100, y: 100, width: 50, height: 50 }, hittable: false };
  assert.equal(isConfirmedOnScreenProbe(probe, CONFIRM_PROBE_ROOT_VIEWPORT), false);
});

test('isConfirmedOnScreenProbe: hittable but OUTSIDE the root viewport -> not confirmed', () => {
  // Counterfactual ("ignore viewport"): change the function to
  // `return probe.hittable;`, dropping the viewport containment check
  // entirely. This test goes red — it pins that a probe's live rect is still
  // checked against the root viewport: hittable alone is not sufficient
  // (the reported rect could still be nonsensical or off-window).
  const probe = { rect: { x: 5000, y: 5000, width: 50, height: 50 }, hittable: true };
  assert.equal(isConfirmedOnScreenProbe(probe, CONFIRM_PROBE_ROOT_VIEWPORT), false);
});

test('isConfirmedOnScreenProbe: neither hittable nor inside the viewport -> not confirmed', () => {
  const probe = { rect: { x: 5000, y: 5000, width: 50, height: 50 }, hittable: false };
  assert.equal(isConfirmedOnScreenProbe(probe, CONFIRM_PROBE_ROOT_VIEWPORT), false);
});

test('isConfirmedOnScreenProbe: a missing root viewport fails open on the geometry half (matches isTapPointInsideViewport)', () => {
  const probe = { rect: { x: 5000, y: 5000, width: 50, height: 50 }, hittable: true };
  assert.equal(isConfirmedOnScreenProbe(probe, null), true);
});
