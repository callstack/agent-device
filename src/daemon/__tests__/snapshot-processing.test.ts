import { test } from 'vitest';
import assert from 'node:assert/strict';
import { attachRefs } from '../../kernel/snapshot.ts';
import {
  extractNodeReadText,
  findNearestHittableAncestor,
  pruneGroupNodes,
} from '../../snapshot/snapshot-processing.ts';

test('pruneGroupNodes drops unlabeled group wrappers and rebalances depth', () => {
  const raw = [
    { index: 0, depth: 0, type: 'XCUIElementTypeWindow', label: 'Root' },
    { index: 1, depth: 1, type: 'XCUIElementTypeGroup' },
    { index: 2, depth: 2, type: 'XCUIElementTypeButton', label: 'Continue' },
  ];
  const pruned = pruneGroupNodes(raw);
  assert.equal(pruned.length, 2);
  assert.equal(pruned[1]!.depth, 1);
  assert.equal(pruned[1]!.label, 'Continue');
});

test('findNearestHittableAncestor walks parents until hittable node', () => {
  const nodes = attachRefs([
    {
      index: 0,
      parentIndex: undefined,
      hittable: true,
      rect: { x: 0, y: 0, width: 100, height: 40 },
    },
    { index: 1, parentIndex: 0, hittable: false, rect: { x: 0, y: 0, width: 50, height: 20 } },
    { index: 2, parentIndex: 1, hittable: false, rect: { x: 0, y: 0, width: 20, height: 20 } },
  ]);
  const ancestor = findNearestHittableAncestor(nodes, nodes[2]!);
  assert.equal(ancestor?.ref, 'e1');
});

test('extractNodeReadText ignores generic implementation identifiers as fallback text', () => {
  const nodes = attachRefs([
    {
      index: 0,
      type: 'android.widget.TextView',
      identifier: 'com.example:id/content_frame',
    },
    {
      index: 1,
      type: 'AXStaticText',
      identifier: '_NS:248',
    },
  ]);
  assert.equal(extractNodeReadText(nodes[0]!), '');
  assert.equal(extractNodeReadText(nodes[1]!), '');
});
