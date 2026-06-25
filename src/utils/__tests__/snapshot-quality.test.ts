import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  formatSparseSnapshotRecoveryHint,
  readSnapshotQualityVerdict,
} from '../snapshot-quality.ts';

test('readSnapshotQualityVerdict accepts a well-formed verdict', () => {
  const verdict = readSnapshotQualityVerdict({
    state: 'recovered',
    backend: 'private-ax',
    reason: 'sparse tree',
    reasonCode: 'budget',
    requestedDepth: 8,
    effectiveDepth: 56,
    collapsedLeafIndexes: [3],
  });
  assert.deepEqual(verdict, {
    state: 'recovered',
    backend: 'private-ax',
    reason: 'sparse tree',
    reasonCode: 'budget',
    requestedDepth: 8,
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

test('formatSparseSnapshotRecoveryHint recommends bounded depths for shallow private AX sparse verdicts', () => {
  const hint = formatSparseSnapshotRecoveryHint({
    state: 'sparse',
    backend: 'private-ax',
    reason: 'snapshot returned only structural application/window nodes',
    reasonCode: 'sparse-tree',
    requestedDepth: 8,
  });

  assert.match(hint, /depth 8/);
  assert.match(hint, /snapshot -i -d 24/);
  assert.match(hint, /snapshot -i -d 40/);
  assert.match(hint, /snapshot -i -d 56/);
  assert.match(hint, /Use screenshot as visual truth/);
});

test('formatSparseSnapshotRecoveryHint recommends bounded depths for shallow XCTest AX rejection', () => {
  const hint = formatSparseSnapshotRecoveryHint({
    state: 'sparse',
    backend: 'tree',
    reason: 'iOS XCTest snapshot failed while serializing the accessibility tree',
    reasonCode: 'ax-rejected',
    requestedDepth: 14,
  });

  assert.match(hint, /depth 14/);
  assert.match(hint, /snapshot -i -d 24/);
  assert.match(hint, /snapshot -i -d 40/);
  assert.match(hint, /snapshot -i -d 56/);
  assert.match(hint, /Use screenshot as visual truth/);
});

test('formatSparseSnapshotRecoveryHint stays generic after deepest bounded depth has already been tried', () => {
  const hint = formatSparseSnapshotRecoveryHint({
    state: 'sparse',
    backend: 'private-ax',
    reasonCode: 'sparse-tree',
    requestedDepth: 56,
  });

  assert.equal(
    hint,
    'Use screenshot as visual truth and coordinate taps; retry snapshot after navigating.',
  );
});
