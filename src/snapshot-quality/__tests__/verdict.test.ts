import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  isSparseSnapshotQualityVerdict,
  preferredSnapshotBackendForVerdict,
  readSnapshotQualityVerdict,
} from '../verdict.ts';

test('readSnapshotQualityVerdict accepts a well-formed verdict', () => {
  const verdict = readSnapshotQualityVerdict({
    state: 'recovered',
    backend: 'private-ax',
    reason: 'sparse tree',
    reasonCode: 'budget',
    effectiveDepth: 56,
    collapsedLeafIndexes: [3],
    customActions: { read: 12, candidates: 19, truncated: 1, blocked: false },
    timing: { acquisitionMs: 12.5, presentationMs: 34.75 },
  });
  assert.deepEqual(verdict, {
    state: 'recovered',
    backend: 'private-ax',
    reason: 'sparse tree',
    reasonCode: 'budget',
    effectiveDepth: 56,
    collapsedLeafIndexes: [3],
    customActions: { read: 12, candidates: 19, truncated: 1, blocked: false },
    timing: { acquisitionMs: 12.5, presentationMs: 34.75 },
  });
});

test('readSnapshotQualityVerdict drops incomplete phase timing without dropping the verdict', () => {
  const verdict = readSnapshotQualityVerdict({
    state: 'healthy',
    backend: 'tree',
    timing: { acquisitionMs: 12.5 },
  });
  assert.equal(verdict?.state, 'healthy');
  assert.equal(verdict?.timing, undefined);
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

test('isSparseSnapshotQualityVerdict identifies sparse captures', () => {
  assert.equal(isSparseSnapshotQualityVerdict({ state: 'sparse', backend: 'private-ax' }), true);
  assert.equal(isSparseSnapshotQualityVerdict({ state: 'healthy', backend: 'tree' }), false);
  assert.equal(isSparseSnapshotQualityVerdict(undefined), false);
});

test('preferredSnapshotBackendForVerdict pins only private-ax captures', () => {
  assert.equal(
    preferredSnapshotBackendForVerdict({ state: 'recovered', backend: 'private-ax' }),
    'private-ax',
  );
  assert.equal(
    preferredSnapshotBackendForVerdict({ state: 'healthy', backend: 'tree' }),
    undefined,
  );
  assert.equal(preferredSnapshotBackendForVerdict(undefined), undefined);
});
