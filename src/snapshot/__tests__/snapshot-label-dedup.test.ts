import { test } from 'vitest';
import assert from 'node:assert/strict';
import { dedupeInheritedSnapshotLabels } from '../snapshot-label-dedup.ts';
import { attachRefs, type RawSnapshotNode } from '../../kernel/snapshot.ts';

function nodes(raw: RawSnapshotNode[]) {
  return attachRefs(raw);
}

test('omits a label that string-equals the nearest ancestor label', () => {
  const input = nodes([
    { index: 0, type: 'ScrollView', label: 'Anthropic HQ', depth: 0 },
    { index: 1, type: 'Other', label: 'Anthropic HQ', depth: 1, parentIndex: 0 },
    { index: 2, type: 'Button', label: 'Anthropic HQ', depth: 2, parentIndex: 1 },
    { index: 3, type: 'Button', label: 'Anthropic HQ', depth: 3, parentIndex: 2 },
  ]);

  const result = dedupeInheritedSnapshotLabels(input);

  assert.equal(result[0]!.label, 'Anthropic HQ');
  assert.equal(result[0]!.inheritsLabel, undefined);
  for (const node of result.slice(1)) {
    assert.equal(node.label, undefined);
    assert.equal(node.inheritsLabel, true);
  }
});

test('keeps a label that differs from every ancestor', () => {
  const input = nodes([
    { index: 0, type: 'ScrollView', label: 'Map', depth: 0 },
    { index: 1, type: 'Button', label: 'Anthropic HQ', depth: 1, parentIndex: 0 },
  ]);

  const result = dedupeInheritedSnapshotLabels(input);

  assert.equal(result[0]!.label, 'Map');
  assert.equal(result[1]!.label, 'Anthropic HQ');
  assert.equal(result[1]!.inheritsLabel, undefined);
});

test('dedups label and identifier independently', () => {
  const input = nodes([
    { index: 0, type: 'Group', label: 'Same', identifier: 'row-1', depth: 0 },
    { index: 1, type: 'Button', label: 'Same', identifier: 'other-id', depth: 1, parentIndex: 0 },
  ]);

  const result = dedupeInheritedSnapshotLabels(input);

  assert.equal(result[1]!.label, undefined);
  assert.equal(result[1]!.inheritsLabel, true);
  assert.equal(result[1]!.identifier, 'other-id');
  assert.equal(result[1]!.inheritsIdentifier, undefined);
});

test('walks past an intermediate node with no label to find the nearest labeled ancestor', () => {
  const input = nodes([
    { index: 0, type: 'ScrollView', label: 'Anthropic HQ', depth: 0 },
    { index: 1, type: 'Other', depth: 1, parentIndex: 0 },
    { index: 2, type: 'Button', label: 'Anthropic HQ', depth: 2, parentIndex: 1 },
  ]);

  const result = dedupeInheritedSnapshotLabels(input);

  assert.equal(result[1]!.label, undefined);
  assert.equal(result[2]!.label, undefined);
  assert.equal(result[2]!.inheritsLabel, true);
});

test('each comparison uses the original ancestor value, not an already-deduped one', () => {
  // Regression guard: if dedup were applied sequentially and re-read from the
  // mutated array, node 2 could fail to match node 1 once node 1's label is
  // stripped. It must still match because node 1's *original* label equals
  // node 0's.
  const input = nodes([
    { index: 0, type: 'ScrollView', label: 'X', depth: 0 },
    { index: 1, type: 'Other', label: 'X', depth: 1, parentIndex: 0 },
    { index: 2, type: 'Button', label: 'X', depth: 2, parentIndex: 1 },
  ]);

  const result = dedupeInheritedSnapshotLabels(input);

  assert.equal(result[1]!.inheritsLabel, true);
  assert.equal(result[2]!.inheritsLabel, true);
});

test('does not touch nodes with no label/identifier at all', () => {
  const input = nodes([
    { index: 0, type: 'ScrollView', label: 'X', depth: 0 },
    { index: 1, type: 'Other', depth: 1, parentIndex: 0 },
  ]);

  const result = dedupeInheritedSnapshotLabels(input);

  assert.equal(result[1]!.label, undefined);
  assert.equal(result[1]!.inheritsLabel, undefined);
});

test('empty input returns empty output', () => {
  assert.deepEqual(dedupeInheritedSnapshotLabels([]), []);
});

test('does not mutate the input nodes', () => {
  const input = nodes([
    { index: 0, type: 'ScrollView', label: 'X', depth: 0 },
    { index: 1, type: 'Button', label: 'X', depth: 1, parentIndex: 0 },
  ]);
  const snapshotBefore = JSON.parse(JSON.stringify(input));

  dedupeInheritedSnapshotLabels(input);

  assert.deepEqual(input, snapshotBefore);
});
