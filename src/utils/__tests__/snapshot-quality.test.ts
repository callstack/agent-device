import { test } from 'vitest';
import assert from 'node:assert/strict';

import { readSnapshotQualityVerdict } from '../../snapshot/snapshot-quality.ts';

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
