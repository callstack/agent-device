import fc from 'fast-check';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildSnapshotDiff, countSnapshotComparableLines } from '../../snapshot/snapshot-diff.ts';
import { buildNodes as nodes } from '../../__tests__/test-utils/snapshot-builders.ts';
import { PROPERTY_RUNS_SMALL, rawSnapshotNodesArb } from '../../__tests__/test-utils/index.ts';

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

// Properties, not more examples: the two invariants a diff consumer relies on
// hold for every tree pair, not for the hand-built ones above — an unchanged
// UI must produce no churn, and the summary must be a count of the rendered
// lines rather than an independently maintained tally.
test('diffing a tree against itself reports no change', () => {
  fc.assert(
    fc.property(rawSnapshotNodesArb, fc.boolean(), (raw, flatten) => {
      const tree = nodes(raw);
      const diff = buildSnapshotDiff(tree, tree, { flatten });
      assert.equal(diff.summary.additions, 0);
      assert.equal(diff.summary.removals, 0);
      assert.equal(diff.summary.unchanged, countSnapshotComparableLines(tree, { flatten }));
      assert.deepEqual(
        diff.lines.filter((line) => line.kind !== 'unchanged'),
        [],
      );
    }),
    { numRuns: PROPERTY_RUNS_SMALL },
  );
});

test('diff summary counts always equal the rendered line counts', () => {
  fc.assert(
    fc.property(
      rawSnapshotNodesArb,
      rawSnapshotNodesArb,
      fc.boolean(),
      (rawPrevious, rawCurrent, flatten) => {
        const previous = nodes(rawPrevious);
        const current = nodes(rawCurrent);
        const diff = buildSnapshotDiff(previous, current, { flatten });
        const counted = { additions: 0, removals: 0, unchanged: 0 };
        for (const line of diff.lines) {
          if (line.kind === 'added') counted.additions += 1;
          if (line.kind === 'removed') counted.removals += 1;
          if (line.kind === 'unchanged') counted.unchanged += 1;
        }
        assert.deepEqual(diff.summary, counted);
        assert.equal(
          diff.summary.additions + diff.summary.unchanged,
          countSnapshotComparableLines(current, { flatten }),
        );
        assert.equal(
          diff.summary.removals + diff.summary.unchanged,
          countSnapshotComparableLines(previous, { flatten }),
        );
      },
    ),
    { numRuns: PROPERTY_RUNS_SMALL },
  );
});
