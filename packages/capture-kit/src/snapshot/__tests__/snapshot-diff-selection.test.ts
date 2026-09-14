import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { buildSnapshotDiff } from '../snapshot-diff.ts';

function tab(selected?: boolean): SnapshotNode {
  return {
    ref: 'e31',
    index: 0,
    depth: 0,
    type: 'android.widget.FrameLayout',
    label: 'Home',
    enabled: true,
    hittable: true,
    ...(selected === undefined ? {} : { selected }),
  };
}

test('a selection-only flip diffs as changed lines that read differently', () => {
  const diff = buildSnapshotDiff([tab(false)], [tab(true)]);
  const changed = diff.lines.filter((line) => line.kind !== 'unchanged');

  assert.equal(diff.summary.unchanged, 0);
  assert.equal(changed.length > 0, true);
  // The comparable key carries selection, so the rendered line has to as. Diff lines are formatted
  // without text-surface summarizing; a line that hid `[selected]` there would print a changed pair
  // whose two lines look identical.
  assert.match(changed.at(-1)!.text, /\[selected\]/);
  assert.doesNotMatch(changed[0]!.text, /\[selected\]/);
});

test.each([
  ['both unselected', [tab(false)], [tab(false)]],
  ['unreported against explicit false', [tab()], [tab(false)]],
])('a still bar with %s diffs as unchanged', (_label, previous, current) => {
  const diff = buildSnapshotDiff(previous, current);

  assert.equal(
    diff.lines.every((line) => line.kind === 'unchanged'),
    true,
  );
  assert.equal(
    diff.lines.every((line) => !line.text.includes('[selected]')),
    true,
  );
});
