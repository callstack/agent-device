import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { buildSnapshotDiff } from '../snapshot-diff.ts';

function toggle(checked?: boolean): SnapshotNode {
  return {
    ref: 'e12',
    index: 0,
    depth: 0,
    type: 'android.widget.Switch',
    label: 'Wi-Fi switch',
    enabled: true,
    hittable: true,
    ...(checked === undefined ? {} : { checked }),
  };
}

test('a checked-only flip diffs as changed lines that read differently', () => {
  const diff = buildSnapshotDiff([toggle(false)], [toggle(true)]);
  const changed = diff.lines.filter((line) => line.kind !== 'unchanged');

  assert.equal(diff.summary.unchanged, 0);
  assert.equal(changed.length > 0, true);
  // The comparable key carries the checked state, so the rendered line has to as well, and both
  // answers render: the pair reads `[unchecked]` -> `[checked]`, not two identical lines.
  assert.match(changed[0]!.text, /\[unchecked\]/);
  assert.match(changed.at(-1)!.text, /\[checked\]/);
});

test.each([
  ['both unchecked', [toggle(false)], [toggle(false)]],
  ['both unreported', [toggle()], [toggle()]],
])('a still toggle with %s diffs as unchanged', (_label, previous, current) => {
  const diff = buildSnapshotDiff(previous, current);

  assert.equal(
    diff.lines.every((line) => line.kind === 'unchanged'),
    true,
  );
});

test('a node that cannot be checked never reads as unchecked', () => {
  const diff = buildSnapshotDiff([toggle()], [toggle()]);
  assert.equal(
    diff.lines.every((line) => !line.text.includes('checked')),
    true,
  );
});
