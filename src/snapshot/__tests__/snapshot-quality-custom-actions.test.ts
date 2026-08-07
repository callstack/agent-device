import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readSnapshotQualityVerdict, renderSnapshotQualityWarnings } from '../snapshot-quality.ts';

const pinned = {
  state: 'recovered',
  backend: 'private-ax',
  reasonCode: 'requested-backend',
} as const;

test('a capped custom-action pass discloses what it did not read', () => {
  const warnings = renderSnapshotQualityWarnings(
    { ...pinned, customActions: { read: 12, candidates: 19, truncated: 0, blocked: false } },
    [],
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /read for 12 of 19 merged elements/);
  assert.match(warnings[0] ?? '', /remaining 7 were not read/);
  // The point of the line: absence must not read as proof of absence.
  assert.match(warnings[0] ?? '', /not evidence that they have none/);
  assert.match(warnings[0] ?? '', /on-screen ones first/);
  assert.match(warnings[0] ?? '', /Scroll them into view/);
});

test('a complete custom-action pass says nothing', () => {
  assert.deepEqual(
    renderSnapshotQualityWarnings(
      { ...pinned, customActions: { read: 19, candidates: 19, truncated: 0, blocked: false } },
      [],
    ),
    [],
  );
  // No merged elements at all is also complete.
  assert.deepEqual(
    renderSnapshotQualityWarnings(
      { ...pinned, customActions: { read: 0, candidates: 0, truncated: 0, blocked: false } },
      [],
    ),
    [],
  );
});

test('a pass blocked by a hung read says so, and does not offer the scroll remedy', () => {
  const warnings = renderSnapshotQualityWarnings(
    { ...pinned, customActions: { read: 0, candidates: 18, truncated: 0, blocked: true } },
    [],
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /still hung/);
  assert.match(warnings[0] ?? '', /skipped the read pass/);
  // Scrolling cannot clear a hung read; borrowing the budget-stop remedy here
  // would send the reader in circles.
  assert.doesNotMatch(warnings[0] ?? '', /Scroll them into view/);
  assert.doesNotMatch(warnings[0] ?? '', /0 of 18/);
});

test('blocked wins over the partial line rather than emitting both', () => {
  // Both conditions are true when a hang stops the pass early, but the partial
  // line's remedy is wrong here, so exactly one line is emitted.
  const warnings = renderSnapshotQualityWarnings(
    { ...pinned, customActions: { read: 3, candidates: 18, truncated: 0, blocked: true } },
    [],
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /still hung/);
});

test('the blocked flag survives verdict parsing and defaults to false', () => {
  assert.equal(
    readSnapshotQualityVerdict({
      state: 'recovered',
      backend: 'private-ax',
      customActions: { read: 0, candidates: 5, truncated: 0, blocked: true },
    })?.customActions?.blocked,
    true,
  );
  assert.equal(
    readSnapshotQualityVerdict({
      state: 'recovered',
      backend: 'private-ax',
      customActions: { read: 1, candidates: 5 },
    })?.customActions?.blocked,
    false,
  );
});

test('a capture that never asked for actions has no coverage and no line', () => {
  assert.deepEqual(renderSnapshotQualityWarnings(pinned, []), []);
});

test('the coverage pair survives verdict parsing, and half a pair does not', () => {
  assert.deepEqual(
    readSnapshotQualityVerdict({
      state: 'recovered',
      backend: 'private-ax',
      customActions: { read: 12, candidates: 19, truncated: 0, blocked: false },
    })?.customActions,
    { read: 12, candidates: 19, truncated: 0, blocked: false },
  );

  // A ratio needs both sides; a partial object is dropped rather than half-read.
  for (const customActions of [{ read: 12 }, { candidates: 19 }, { read: '12', candidates: 19 }]) {
    assert.equal(
      readSnapshotQualityVerdict({ state: 'recovered', backend: 'private-ax', customActions })
        ?.customActions,
      undefined,
    );
  }

  // The truncation count is additive, so an older runner that omits it keeps a
  // usable ratio instead of voiding the whole coverage.
  assert.deepEqual(
    readSnapshotQualityVerdict({
      state: 'recovered',
      backend: 'private-ax',
      customActions: { read: 12, candidates: 19 },
    })?.customActions,
    { read: 12, candidates: 19, truncated: 0, blocked: false },
  );
});

test('a clipped action list is disclosed even when every candidate was read', () => {
  const warnings = renderSnapshotQualityWarnings(
    { ...pinned, customActions: { read: 19, candidates: 19, truncated: 2, blocked: false } },
    [],
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /2 element\(s\) published more custom actions than are shown/);
});

test('an incomplete pass that also clipped reports both, one line each', () => {
  const warnings = renderSnapshotQualityWarnings(
    { ...pinned, customActions: { read: 12, candidates: 19, truncated: 3, blocked: false } },
    [],
  );

  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? '', /read for 12 of 19 merged elements/);
  assert.match(warnings[1] ?? '', /3 element\(s\) published more/);
});

test('the coverage line is independent of degradation state', () => {
  // A healthy capture can still have hit the read cap.
  const warnings = renderSnapshotQualityWarnings(
    {
      state: 'healthy',
      backend: 'private-ax',
      customActions: { read: 3, candidates: 8, truncated: 0, blocked: false },
    },
    [],
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /read for 3 of 8 merged elements/);
});
