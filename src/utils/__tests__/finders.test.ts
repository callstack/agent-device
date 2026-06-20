import { test } from 'vitest';
import assert from 'node:assert/strict';
import { findBestMatchesByLocator } from '../finders.ts';
import type { SnapshotNode } from '../snapshot.ts';

function makeNode(ref: string, label?: string, identifier?: string): SnapshotNode {
  return {
    index: Number(ref.replace('e', '')) || 0,
    ref,
    type: 'android.widget.TextView',
    label,
    identifier,
    rect: { x: 0, y: 0, width: 100, height: 20 },
  };
}

test('findBestMatchesByLocator returns all best-scored matches', () => {
  const nodes: SnapshotNode[] = [
    makeNode('e1', 'Continue'),
    makeNode('e2', 'Continue'),
    makeNode('e3', 'Continue later'),
  ];
  const result = findBestMatchesByLocator(nodes, 'label', 'Continue', { requireRect: true });
  assert.equal(result.score, 2);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0]?.ref, 'e1');
  assert.equal(result.matches[1]?.ref, 'e2');
});
