import { test } from 'vitest';
import assert from 'node:assert/strict';
import { dedupeInheritedSnapshotLabels } from '../snapshot-label-dedup.ts';
import { attachRefs, type RawSnapshotNode } from '../../kernel/snapshot.ts';

function nodes(raw: RawSnapshotNode[]) {
  return attachRefs(raw);
}

test('omits a label that string-equals the nearest ancestor label', () => {
  const input = nodes([
    { index: 0, type: 'ScrollView', label: 'Anthropic - Headquarters, 548 Market St', depth: 0 },
    {
      index: 1,
      type: 'Other',
      label: 'Anthropic - Headquarters, 548 Market St',
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      type: 'Button',
      label: 'Anthropic - Headquarters, 548 Market St',
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 3,
      type: 'Button',
      label: 'Anthropic - Headquarters, 548 Market St',
      depth: 3,
      parentIndex: 2,
    },
  ]);

  const result = dedupeInheritedSnapshotLabels(input);

  assert.equal(result[0]!.label, 'Anthropic - Headquarters, 548 Market St');
  assert.equal(result[0]!.inheritsLabel, undefined);
  for (const node of result.slice(1)) {
    assert.equal(node.label, undefined);
    assert.equal(node.inheritsLabel, true);
  }
});

test('keeps a label that differs from every ancestor', () => {
  const input = nodes([
    { index: 0, type: 'ScrollView', label: 'Map', depth: 0 },
    {
      index: 1,
      type: 'Button',
      label: 'Anthropic - Headquarters, 548 Market St',
      depth: 1,
      parentIndex: 0,
    },
  ]);

  const result = dedupeInheritedSnapshotLabels(input);

  assert.equal(result[0]!.label, 'Map');
  assert.equal(result[1]!.label, 'Anthropic - Headquarters, 548 Market St');
  assert.equal(result[1]!.inheritsLabel, undefined);
});

test('dedups label and identifier independently', () => {
  const input = nodes([
    {
      index: 0,
      type: 'Group',
      label: 'A very long shared accessibility label',
      identifier: 'row-1',
      depth: 0,
    },
    {
      index: 1,
      type: 'Button',
      label: 'A very long shared accessibility label',
      identifier: 'other-id',
      depth: 1,
      parentIndex: 0,
    },
  ]);

  const result = dedupeInheritedSnapshotLabels(input);

  assert.equal(result[1]!.label, undefined);
  assert.equal(result[1]!.inheritsLabel, true);
  assert.equal(result[1]!.identifier, 'other-id');
  assert.equal(result[1]!.inheritsIdentifier, undefined);
});

test('walks past an intermediate node with no label to find the nearest labeled ancestor', () => {
  const input = nodes([
    { index: 0, type: 'ScrollView', label: 'Anthropic - Headquarters, 548 Market St', depth: 0 },
    { index: 1, type: 'Other', depth: 1, parentIndex: 0 },
    {
      index: 2,
      type: 'Button',
      label: 'Anthropic - Headquarters, 548 Market St',
      depth: 2,
      parentIndex: 1,
    },
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
    { index: 0, type: 'ScrollView', label: 'A very long shared accessibility label X', depth: 0 },
    {
      index: 1,
      type: 'Other',
      label: 'A very long shared accessibility label X',
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      type: 'Button',
      label: 'A very long shared accessibility label X',
      depth: 2,
      parentIndex: 1,
    },
  ]);

  const result = dedupeInheritedSnapshotLabels(input);

  assert.equal(result[1]!.inheritsLabel, true);
  assert.equal(result[2]!.inheritsLabel, true);
});

test('does not touch nodes with no label/identifier at all', () => {
  const input = nodes([
    { index: 0, type: 'ScrollView', label: 'A very long shared accessibility label X', depth: 0 },
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
    { index: 0, type: 'ScrollView', label: 'A very long shared accessibility label X', depth: 0 },
    {
      index: 1,
      type: 'Button',
      label: 'A very long shared accessibility label X',
      depth: 1,
      parentIndex: 0,
    },
  ]);
  const snapshotBefore = JSON.parse(JSON.stringify(input));

  dedupeInheritedSnapshotLabels(input);

  assert.deepEqual(input, snapshotBefore);
});

test('short duplicated labels stay verbatim (marker would cost more than it saves)', () => {
  const result = dedupeInheritedSnapshotLabels(
    nodes([
      { index: 0, type: 'Other', label: 'Home', depth: 0 },
      { index: 1, parentIndex: 0, type: 'Button', label: 'Home', depth: 1 },
    ]),
  );
  assert.equal(result[1]!.label, 'Home');
  assert.equal(result[1]!.inheritsLabel, undefined);
});
