import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readSnapshotQualityVerdict } from '../verdict.ts';
import { renderSnapshotQualityWarnings } from '../warnings.ts';

test("the runner-wire 'deferred' reasonCode survives parsing into warning suppression", () => {
  // End-to-end through the raw wire parser: 'deferred' must be a member of the accepted
  // reason-code set, or it is silently stripped and every downstream deferred behavior
  // (warning suppression, settle budget-reset skip) quietly reverts.
  const verdict = readSnapshotQualityVerdict({
    state: 'recovered',
    backend: 'private-ax',
    reason: 'XCTest-backed snapshot tiers were deferred after recent slow accessibility work',
    reasonCode: 'deferred',
  });
  assert.equal(verdict?.reasonCode, 'deferred');
  assert.deepEqual(renderSnapshotQualityWarnings(verdict!, []), []);
});

test('penalty-deferred recovered captures suppress the fallback warning but keep depth copy', () => {
  // Every capture of a hostile screen re-stamps recovered/deferred; the capture that armed the
  // penalty already carried the full warning, so repeating it each capture is context noise.
  const warnings = renderSnapshotQualityWarnings(
    {
      state: 'recovered',
      backend: 'private-ax',
      reason: 'XCTest-backed snapshot tiers were deferred after recent slow accessibility work',
      reasonCode: 'deferred',
      effectiveDepth: 56,
    },
    [],
  );

  assert.deepEqual(warnings, [
    'Some deeper accessibility nodes were omitted; this tree is capped at depth 56. Re-run with --depth 56 --scope <container> only if you need deeper content.',
  ]);
});

test('renderSnapshotQualityWarnings keeps recovered snapshot copy concise', () => {
  const warnings = renderSnapshotQualityWarnings(
    {
      state: 'recovered',
      backend: 'private-ax',
      reason:
        'iOS XCTest snapshot failed while serializing the accessibility tree. Error kAXErrorIllegalArgument getting snapshot for element <AXUIElementRef 0x1>',
      reasonCode: 'ax-rejected',
      effectiveDepth: 56,
    },
    [],
  );

  assert.deepEqual(warnings, [
    'Detected an overly complex or slow accessibility tree. Fell back to the private-ax snapshot backend. It is OK to continue; use --json to inspect snapshotQuality.reason if you need recovery details.',
    'Some deeper accessibility nodes were omitted; this tree is capped at depth 56. Re-run with --depth 56 --scope <container> only if you need deeper content.',
  ]);
});

test('renderSnapshotQualityWarnings rejects semantic targets from a sparse tree', () => {
  const warnings = renderSnapshotQualityWarnings(
    {
      state: 'sparse',
      backend: 'private-ax',
      reason: 'snapshot returned no semantic controls or content',
      reasonCode: 'sparse-tree',
    },
    [],
  );

  assert.deepEqual(warnings, [
    'No snapshot backend could read this screen (snapshot returned no semantic controls or content). Its refs and selectors are invalid. Use screenshot as visual truth and coordinate taps; retry snapshot after navigating.',
  ]);
});

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
