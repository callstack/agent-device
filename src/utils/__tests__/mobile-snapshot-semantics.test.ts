import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildMobileSnapshotPresentation,
  isNodeVisibleInEffectiveViewport,
} from '../../snapshot/mobile-snapshot-semantics.ts';
import type { SnapshotNode } from '../../kernel/snapshot.ts';

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
