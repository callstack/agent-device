import assert from 'node:assert/strict';
import { test } from 'vitest';
import { findBestMatchesByLocator, parseFindArgs } from '../finders.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';

function makeNode(ref: string, label?: string): SnapshotNode {
  return {
    index: Number(ref.replace('e', '')) || 0,
    ref,
    type: 'XCUIElementTypeButton',
    label,
  };
}

test('public finders entrypoint re-exports pure helpers', () => {
  const nodes: SnapshotNode[] = [makeNode('e1', 'Continue')];

  const parsed = parseFindArgs(['label', 'Continue', 'click']);
  const best = findBestMatchesByLocator(nodes, 'label', 'Continue');
  const requireRectLegacy = findBestMatchesByLocator(nodes, 'label', 'Continue', true);
  const requireRectOptions = findBestMatchesByLocator(nodes, 'label', 'Continue', {
    requireRect: true,
  });

  assert.equal(parsed.action, 'click');
  assert.equal(best.matches.length, 1);
  assert.equal(requireRectLegacy.matches.length, 0);
  assert.equal(requireRectOptions.matches.length, 0);
});
