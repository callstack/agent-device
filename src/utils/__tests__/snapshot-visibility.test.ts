import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildSnapshotVisibility } from '../../snapshot/snapshot-visibility.ts';
import type { SnapshotNode } from '../../kernel/snapshot.ts';

const FULLSCREEN_ROOT = { x: 0, y: 0, width: 390, height: 844 };
const OFFSCREEN_RECT = { x: 0, y: 1200, width: 120, height: 44 };

function nodesWithOffscreenChild(): SnapshotNode[] {
  return [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Window',
      role: 'document',
      rect: FULLSCREEN_ROOT,
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'web.button',
      role: 'button',
      label: 'Offscreen action',
      rect: OFFSCREEN_RECT,
    },
  ];
}

test('buildSnapshotVisibility treats web snapshots as full-tree output', () => {
  const visibility = buildSnapshotVisibility({
    nodes: nodesWithOffscreenChild(),
    backend: 'web',
  });

  assert.deepEqual(visibility, {
    partial: false,
    visibleNodeCount: 2,
    totalNodeCount: 2,
    reasons: [],
  });
});

test('buildSnapshotVisibility keeps legacy missing backend snapshots in mobile presentation mode', () => {
  const visibility = buildSnapshotVisibility({ nodes: nodesWithOffscreenChild() });

  assert.equal(visibility.partial, true);
  assert.equal(visibility.visibleNodeCount, 1);
  assert.equal(visibility.totalNodeCount, 2);
  assert.deepEqual(visibility.reasons, ['offscreen-nodes']);
});
