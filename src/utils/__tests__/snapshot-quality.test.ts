import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  readSnapshotQualityVerdict,
  renderSnapshotQualityWarnings,
} from '../../snapshot/snapshot-quality.ts';

test('readSnapshotQualityVerdict accepts a well-formed verdict', () => {
  const verdict = readSnapshotQualityVerdict({
    state: 'recovered',
    backend: 'private-ax',
    reason: 'sparse tree',
    reasonCode: 'budget',
    effectiveDepth: 56,
    collapsedLeafIndexes: [3],
  });
  assert.deepEqual(verdict, {
    state: 'recovered',
    backend: 'private-ax',
    reason: 'sparse tree',
    reasonCode: 'budget',
    effectiveDepth: 56,
    collapsedLeafIndexes: [3],
  });
});

test('readSnapshotQualityVerdict rejects unknown state or backend as verdict-absent', () => {
  // A malformed object must not be treated as an authoritative verdict — it has to fall through
  // so legacy node-shape detectors still run instead of being silently suppressed.
  assert.equal(readSnapshotQualityVerdict({ state: 'bogus', backend: 'tree' }), undefined);
  assert.equal(readSnapshotQualityVerdict({ state: 'sparse', backend: 'mystery' }), undefined);
  assert.equal(readSnapshotQualityVerdict({ backend: 'tree' }), undefined);
  assert.equal(readSnapshotQualityVerdict(null), undefined);
});

test('readSnapshotQualityVerdict keeps the verdict but drops an unknown reasonCode', () => {
  // Forward-compat: a newer runner adding a reasonCode must still yield a usable verdict.
  const verdict = readSnapshotQualityVerdict({
    state: 'sparse',
    backend: 'queries',
    reasonCode: 'future-code',
  });
  assert.equal(verdict?.state, 'sparse');
  assert.equal(verdict?.reasonCode, undefined);
});

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
