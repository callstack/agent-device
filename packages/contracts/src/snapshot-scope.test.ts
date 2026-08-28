import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { matchesSnapshotScope, normalizeSnapshotScope } from './facades/snapshot.ts';

// Golden scope-policy table (#1797 / #1832 C2): the SAME JSON is asserted against every runtime
// that resolves `--scope` — this predicate, the Android platform projection
// (packages/platform-android/src/__tests__/ui-hierarchy-scope.test.ts), and the Swift runner twin.
// This file proves the PREDICATE + first-document-order-match rule; subtree slicing is proved by
// the runtime legs.

type ScopePolicyNode = {
  depth: number;
  label?: string;
  value?: string;
  identifier?: string;
  presented?: boolean;
};
type ScopePolicyCase = {
  name: string;
  scope: string;
  nodes: ScopePolicyNode[];
  expectedRootIndex: number | null;
  expectedSubtreeIndexes: number[];
};

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'snapshot-scope-policy.json',
);

test('the shared scope policy picks the first matching subtree with presented content', () => {
  const cases = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as ScopePolicyCase[];
  assert.ok(cases.length > 0, 'scope policy table must not be empty');
  assert.equal(new Set(cases.map((fixture) => fixture.name)).size, cases.length);
  for (const fixture of cases) {
    if (!normalizeSnapshotScope(fixture.scope)) {
      assert.equal(fixture.expectedRootIndex, null, fixture.name);
      assert.deepEqual(
        fixture.expectedSubtreeIndexes,
        fixture.nodes.map((_, index) => index),
      );
      continue;
    }
    const rootIndex = fixture.nodes.findIndex(
      (node, index) =>
        matchesSnapshotScope(node, fixture.scope) &&
        subtreeIndexes(fixture.nodes, index).some(
          (subtreeIndex) => fixture.nodes[subtreeIndex]?.presented !== false,
        ),
    );
    assert.equal(rootIndex === -1 ? null : rootIndex, fixture.expectedRootIndex, fixture.name);
    assert.deepEqual(
      subtreeIndexes(fixture.nodes, fixture.expectedRootIndex),
      fixture.expectedSubtreeIndexes,
      `${fixture.name}: expectedSubtreeIndexes must be the root's document-order subtree`,
    );
  }
});

/** The table's own consistency: subtree = root + following nodes deeper than the root. */
function subtreeIndexes(nodes: ScopePolicyNode[], rootIndex: number | null): number[] {
  if (rootIndex === null) return [];
  const rootDepth = nodes[rootIndex]!.depth;
  const indexes = [rootIndex];
  for (let index = rootIndex + 1; index < nodes.length; index += 1) {
    if (nodes[index]!.depth <= rootDepth) break;
    indexes.push(index);
  }
  return indexes;
}
