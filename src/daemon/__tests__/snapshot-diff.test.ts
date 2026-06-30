import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildSnapshotDiff } from '../../snapshot/snapshot-diff.ts';
import { buildNodes as nodes } from '../../__tests__/test-utils/snapshot-builders.ts';

test('buildSnapshotDiff reports unchanged lines when snapshots are equal', () => {
  const previous = nodes([
    { index: 0, depth: 0, type: 'XCUIElementTypeWindow' },
    { index: 1, depth: 1, type: 'XCUIElementTypeButton', label: 'Increment' },
  ]);
  const current = nodes([
    { index: 0, depth: 0, type: 'XCUIElementTypeWindow' },
    { index: 1, depth: 1, type: 'XCUIElementTypeButton', label: 'Increment' },
  ]);

  const diff = buildSnapshotDiff(previous, current);
  assert.equal(diff.summary.additions, 0);
  assert.equal(diff.summary.removals, 0);
  assert.equal(diff.summary.unchanged, 2);
  assert.deepEqual(
    diff.lines.map((line) => line.kind),
    ['unchanged', 'unchanged'],
  );
});

test('buildSnapshotDiff reports added and removed lines', () => {
  const previous = nodes([
    { index: 0, depth: 0, type: 'XCUIElementTypeWindow' },
    { index: 1, depth: 1, type: 'XCUIElementTypeStaticText', label: '67' },
    { index: 2, depth: 1, type: 'XCUIElementTypeButton', label: 'Increment' },
  ]);
  const current = nodes([
    { index: 0, depth: 0, type: 'XCUIElementTypeWindow' },
    { index: 1, depth: 1, type: 'XCUIElementTypeStaticText', label: '134' },
    { index: 2, depth: 1, type: 'XCUIElementTypeButton', label: 'Increment' },
  ]);

  const diff = buildSnapshotDiff(previous, current);
  assert.equal(diff.summary.additions, 1);
  assert.equal(diff.summary.removals, 1);
  assert.equal(diff.summary.unchanged, 2);
  assert.deepEqual(
    diff.lines.map((line) => line.kind),
    ['unchanged', 'removed', 'added', 'unchanged'],
  );
});

test('buildSnapshotDiff treats value changes as remove plus add', () => {
  const previous = nodes([
    { index: 0, depth: 0, type: 'XCUIElementTypeTextField', label: 'Amount', value: '67' },
  ]);
  const current = nodes([
    { index: 0, depth: 0, type: 'XCUIElementTypeTextField', label: 'Amount', value: '134' },
  ]);

  const diff = buildSnapshotDiff(previous, current);
  assert.equal(diff.summary.additions, 1);
  assert.equal(diff.summary.removals, 1);
  assert.equal(diff.summary.unchanged, 0);
  assert.deepEqual(
    diff.lines.map((line) => line.kind),
    ['removed', 'added'],
  );
});

test('buildSnapshotDiff preserves surrounding context ordering', () => {
  const previous = nodes([
    { index: 0, depth: 0, type: 'XCUIElementTypeWindow' },
    { index: 1, depth: 1, type: 'XCUIElementTypeStaticText', label: 'Count' },
    { index: 2, depth: 1, type: 'XCUIElementTypeStaticText', label: '67' },
    { index: 3, depth: 1, type: 'XCUIElementTypeButton', label: 'Increment' },
  ]);
  const current = nodes([
    { index: 0, depth: 0, type: 'XCUIElementTypeWindow' },
    { index: 1, depth: 1, type: 'XCUIElementTypeStaticText', label: 'Count' },
    { index: 2, depth: 1, type: 'XCUIElementTypeStaticText', label: '134' },
    { index: 3, depth: 1, type: 'XCUIElementTypeButton', label: 'Increment' },
  ]);

  const diff = buildSnapshotDiff(previous, current);
  assert.equal(diff.lines[0]?.kind, 'unchanged');
  assert.equal(diff.lines[1]?.kind, 'unchanged');
  assert.equal(diff.lines[2]?.kind, 'removed');
  assert.equal(diff.lines[3]?.kind, 'added');
  assert.equal(diff.lines[4]?.kind, 'unchanged');
});

test('buildSnapshotDiff flatten option uses flat snapshot line shape', () => {
  const previous = nodes([
    { index: 0, depth: 0, type: 'XCUIElementTypeWindow' },
    { index: 1, depth: 1, type: 'XCUIElementTypeOther', label: '335' },
    { index: 2, depth: 2, type: 'XCUIElementTypeStaticText', label: '335' },
  ]);
  const current = nodes([
    { index: 0, depth: 0, type: 'XCUIElementTypeWindow' },
    { index: 1, depth: 1, type: 'XCUIElementTypeOther', label: '402' },
    { index: 2, depth: 2, type: 'XCUIElementTypeStaticText', label: '402' },
  ]);

  const diff = buildSnapshotDiff(previous, current, { flatten: true });
  assert.equal(diff.summary.additions, 2);
  assert.equal(diff.summary.removals, 2);
  const changed = diff.lines.filter((line) => line.kind !== 'unchanged');
  assert.equal(changed.length, 4);
  for (const line of changed) {
    assert.equal(line.text.startsWith('  '), false);
  }
});
