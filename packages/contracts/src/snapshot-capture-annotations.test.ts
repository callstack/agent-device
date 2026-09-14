import assert from 'node:assert/strict';
import { test } from 'vitest';
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
