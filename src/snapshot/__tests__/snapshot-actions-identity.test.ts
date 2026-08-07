import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildSnapshotPresentationKey } from '@agent-device/kernel/snapshot';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { buildSnapshotDiff } from '../snapshot-diff.ts';

function card(actions?: string[]): SnapshotNode {
  return {
    ref: 'e8',
    index: 0,
    depth: 0,
    type: 'Link',
    label: 'feedItem-by-whiskers.test',
    enabled: true,
    hittable: true,
    ...(actions ? { actions } : {}),
  };
}

test('an action-only change is a diff, not an unchanged line', () => {
  const diff = buildSnapshotDiff([card(['Reply'])], [card(['Reply', 'Repost'])]);
  const kinds = diff.lines.map((line) => line.kind);

  // The rendered text already differs; the comparable key has to agree, or the
  // line is reported unchanged while showing different content.
  assert.equal(kinds.includes('unchanged'), false);
  assert.equal(diff.summary.unchanged, 0);
  assert.equal(diff.summary.additions + diff.summary.removals > 0, true);
});

test('gaining actions where there were none is a diff', () => {
  const diff = buildSnapshotDiff([card()], [card(['Reply'])]);

  assert.equal(
    diff.lines.every((line) => line.kind !== 'unchanged'),
    true,
  );
});

test('identical actions still compare as unchanged', () => {
  const diff = buildSnapshotDiff([card(['Reply', 'Repost'])], [card(['Reply', 'Repost'])]);

  assert.equal(
    diff.lines.every((line) => line.kind === 'unchanged'),
    true,
  );
});

test('asking for custom actions is a different presentation than not asking', () => {
  // Otherwise `snapshot` then `snapshot --actions` on a still screen answers
  // "unchanged" and never delivers the actions that were explicitly requested.
  assert.notEqual(
    buildSnapshotPresentationKey({ interactiveOnly: true }),
    buildSnapshotPresentationKey({ interactiveOnly: true, customActions: true }),
  );
  assert.equal(
    buildSnapshotPresentationKey({ interactiveOnly: true, customActions: false }),
    buildSnapshotPresentationKey({ interactiveOnly: true }),
  );
});
