import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatRole } from '@agent-device/kernel/snapshot';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import { isScrollableNodeLike, isScrollableType } from './snapshot-scroll.ts';

function node(input: RawSnapshotNode): SnapshotNode {
  return { ...input, ref: `@e${input.index}`, kind: formatRole(input.type ?? 'Element') };
}

test('snapshot scroll semantics classify scrollable types and node-like roles', () => {
  const scrollView = node({ index: 1, type: 'ScrollView', parentIndex: 0 });

  assert.equal(isScrollableType('android.widget.RecyclerView'), true);
  assert.equal(isScrollableNodeLike(scrollView), true);
  assert.equal(isScrollableNodeLike({ role: 'scrollbar' }), true);
});
