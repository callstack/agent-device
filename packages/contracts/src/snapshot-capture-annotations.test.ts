import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SNAPSHOT_QUALITY_STATES } from '@agent-device/kernel/snapshot';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { readSerializedSnapshotCaptureAnnotations } from './snapshot-capture-annotations.ts';

test('the annotations filter and the shared warnings parser agree on adversarial arrays', () => {
  for (const warnings of [
    ['a note'],
    ['a note', 42, { nested: true }, null],
    ['', 'kept'],
    ['a note', ''],
  ]) {
    assert.deepEqual(
      readSerializedSnapshotCaptureAnnotations({ warnings }).warnings,
      readResponseWarnings({ warnings }),
      `drift for ${JSON.stringify(warnings)}`,
    );
  }
});

test('an empty warnings array serializes back to absent', () => {
  assert.equal(readSerializedSnapshotCaptureAnnotations({ warnings: [] }).warnings, undefined);
});

test('absent or non-array warnings stay absent on the serialized annotations', () => {
  assert.equal(readSerializedSnapshotCaptureAnnotations({}).warnings, undefined);
  assert.equal(
    readSerializedSnapshotCaptureAnnotations({ warnings: 'a note' }).warnings,
    undefined,
  );
});

test('every wire verdict state survives the serialized annotations', () => {
  for (const state of SNAPSHOT_QUALITY_STATES) {
    const verdict = {
      state,
      backend: 'private-ax',
      reason: 'tree capture timed out',
      reasonCode: 'budget',
      effectiveDepth: 56,
      collapsedLeafIndexes: [3],
      customActions: { read: 12, candidates: 19, truncated: 1, blocked: false },
      timing: { acquisitionMs: 12.5, presentationMs: 34.75 },
    };
    assert.deepEqual(
      readSerializedSnapshotCaptureAnnotations({ snapshotQuality: verdict }).snapshotQuality,
      verdict,
    );
  }
});

/**
 * This reader runs on the daemon's serialized response, and it used to project any string into the
 * verdict type. A state the declared vocabulary does not name now reads as verdict-absent, which is
 * what lets the shape-based fallback stay in charge instead of a disclosure for nothing.
 */
test('a state outside the declared vocabulary drops the serialized verdict', () => {
  for (const state of [
    'heathy',
    'healthy ',
    'Sparse',
    'degraded',
    'constructor',
    '',
    42,
    null,
    undefined,
  ]) {
    const annotations = readSerializedSnapshotCaptureAnnotations({
      snapshotQuality: { state, backend: 'tree' },
    });
    assert.equal(annotations.snapshotQuality, undefined, JSON.stringify(state));
  }
});

/**
 * `backend` names the recovery strategy in the user-facing warning line, so it goes through the
 * declared strategies too: a strategy this version cannot name is not a verdict it can present. The
 * optional fields are forwarded as published (see the reader); normalizing them is capture-kit.
 */
test('an undeclared backend drops the serialized verdict', () => {
  for (const backend of ['uiautomator', 'tree ', 'Tree', 'constructor', '', 42, null, undefined]) {
    const annotations = readSerializedSnapshotCaptureAnnotations({
      snapshotQuality: { state: 'sparse', backend },
    });
    assert.equal(annotations.snapshotQuality, undefined, JSON.stringify(backend));
  }
});
