import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { buildSnapshotDiff } from '../snapshot-diff.ts';

function screen(prefix: string, count: number): SnapshotNode[] {
  return Array.from({ length: count }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'XCUIElementTypeStaticText',
    label: `${prefix} ${index}`,
  }));
}

test('two disjoint 3,000-line screens diff within the edit-distance budget', () => {
  // A navigation replaces every line: the edit distance is 6,000. Copying a Map of every reached
  // diagonal per step held about 1.8e7 entries; the trace now holds typed slices of the same size.
  const started = performance.now();
  const diff = buildSnapshotDiff(screen('Before', 3_000), screen('After', 3_000), {
    flatten: true,
  });
  const elapsedMs = performance.now() - started;
  assert.deepEqual(diff.summary, { additions: 3_000, removals: 3_000, unchanged: 0 });
  assert.ok(elapsedMs < 3_000, `disjoint diff took ${Math.round(elapsedMs)}ms`);
});

test('a shared leading block is reported unchanged before the changed tail', () => {
  const shared = screen('Shared', 2_000);
  const diff = buildSnapshotDiff(
    [...shared, ...screen('Old', 2)],
    [...shared, ...screen('New', 3)],
    {
      flatten: true,
    },
  );
  assert.deepEqual(diff.summary, { additions: 3, removals: 2, unchanged: 2_000 });
  assert.equal(
    diff.lines.slice(0, 2_000).every((line) => line.kind === 'unchanged'),
    true,
  );
});
