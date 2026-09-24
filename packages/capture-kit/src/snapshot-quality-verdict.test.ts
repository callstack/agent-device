import { test } from 'vitest';
import assert from 'node:assert/strict';

import { readSerializedSnapshotCaptureAnnotations } from '@agent-device/contracts/capture';
import { SNAPSHOT_QUALITY_STATES } from '@agent-device/kernel/snapshot';
import {
  isSparseSnapshotQualityVerdict,
  preferredSnapshotBackendForVerdict,
  readSnapshotQualityVerdict,
} from './snapshot-quality-verdict.ts';

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
  // An inherited key is not a declared state: membership stays on the map's own keys.
  assert.equal(readSnapshotQualityVerdict({ state: 'constructor', backend: 'tree' }), undefined);
});

test('readSnapshotQualityVerdict reads every declared wire state', () => {
  for (const state of SNAPSHOT_QUALITY_STATES) {
    assert.deepEqual(readSnapshotQualityVerdict({ state, backend: 'tree' }), {
      state,
      backend: 'tree',
      reason: undefined,
      reasonCode: undefined,
      customActions: undefined,
      effectiveDepth: undefined,
      collapsedLeafIndexes: undefined,
    });
  }
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

test('readSnapshotQualityVerdict preserves a presentation failure reason', () => {
  const verdict = readSnapshotQualityVerdict({
    state: 'sparse',
    backend: 'tree',
    reason: 'regular snapshot node 7 escaped its cumulative clip',
    reasonCode: 'presentation-failed',
  });

  assert.equal(verdict?.reasonCode, 'presentation-failed');
});

test('readSnapshotQualityVerdict accepts the Android helper backend', () => {
  const verdict = readSnapshotQualityVerdict({
    state: 'healthy',
    backend: 'android-helper',
  });

  assert.equal(verdict?.state, 'healthy');
  assert.equal(verdict?.backend, 'android-helper');
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

/**
 * Two readings of one verdict exist on purpose: this module normalizes an untrusted runner payload,
 * while contracts re-publishes what this repo published and normalizes nothing (the eager-closure
 * gate forbids either reaching a shared module, and the duplication gate refuses a second
 * normalization). They must still agree on which payloads are a verdict at all: a name one version
 * cannot speak is verdict-absent on both sides of the daemon boundary.
 */
const VERDICT_PAYLOADS: unknown[] = [
  { state: 'sparse', backend: 'private-ax' },
  { state: 'healthy', backend: 'tree', reason: 'ok', reasonCode: 'requested-backend' },
  { state: 'recovered', backend: 'queries', reason: 42, effectiveDepth: '56' },
  { state: 'sparse', backend: 'tree', collapsedLeafIndexes: [3, 'four'] },
  { state: 'sparse', backend: 'tree', customActions: { read: 12 } },
  { state: 'sparse', backend: 'tree', customActions: { read: 12, candidates: 19 } },
  { state: 'sparse', backend: 'tree', timing: { acquisitionMs: 12.5 } },
  { state: 'sparse', backend: 'tree', timing: { acquisitionMs: 12.5, presentationMs: 34.75 } },
  { state: 'sparse', backend: 'tree', reasonCode: 'future-code' },
  { state: 'degraded', backend: 'tree' },
  { state: 'sparse', backend: 'uiautomator' },
  { state: 'constructor', backend: 'constructor' },
  { backend: 'tree' },
  { state: 'sparse' },
  null,
  'verdict',
];

test('the contracts re-read calls a verdict a verdict on every payload', () => {
  for (const payload of VERDICT_PAYLOADS) {
    const reRead = readSerializedSnapshotCaptureAnnotations({
      snapshotQuality: payload,
    }).snapshotQuality;
    assert.equal(
      reRead === undefined,
      readSnapshotQualityVerdict(payload) === undefined,
      JSON.stringify(payload),
    );
  }
});
