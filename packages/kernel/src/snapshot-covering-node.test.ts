import { test } from 'vitest';
import assert from 'node:assert/strict';
import { coveredInteractionHint, type SnapshotCoveringNode } from './snapshot.ts';

const cover: SnapshotCoveringNode = {
  kind: 'tab-bar',
  label: 'Media',
  rect: { x: 0.4, y: 760.2, width: 390.5, height: 84 },
};

test('coveredInteractionHint names the cover with rounded geometry', () => {
  assert.match(
    coveredInteractionHint(cover),
    /^Covered by the tab-bar "Media" at \(0, 760 391x84\)\. Dismiss or close that element/,
  );
});

test('coveredInteractionHint keeps the hint one line when the cover label carries newlines or quotes', () => {
  // The label is app-controlled text; the hint must stay a single unambiguous line, and only the
  // rendering is sanitized — callers can still read the raw label on the coveredBy detail.
  const dirty = coveredInteractionHint({
    ...cover,
    label: '  Dismiss\n  "now"  ',
  });
  assert.match(dirty, /the tab-bar "Dismiss now" at/);
  assert.doesNotMatch(dirty, /\n/);
});

test('coveredInteractionHint falls back to the bare kind when the label sanitizes to nothing', () => {
  assert.match(coveredInteractionHint({ ...cover, label: '""\n' }), /^Covered by the tab-bar at/);
});

test('coveredInteractionHint keeps the generic recovery without a cover', () => {
  assert.equal(
    coveredInteractionHint(undefined),
    'Use a different visible target, scroll it clear of the overlay, or inspect with snapshot/screenshot before retrying.',
  );
});
