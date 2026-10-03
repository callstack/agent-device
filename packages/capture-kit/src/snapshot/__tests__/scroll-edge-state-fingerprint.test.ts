import { test } from 'vitest';
import assert from 'node:assert/strict';
import { capture, recycledCellSnapshot } from './scroll-edge-state-fixtures.ts';

test('surface signature changes when a recycled cell keeps its slot but changes text', async () => {
  const before = await capture(recycledCellSnapshot('First story'));
  const after = await capture(recycledCellSnapshot('Second story'));
  assert.ok(before.fingerprint && after.fingerprint);
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test('surface signature is stable when nothing on the container moves', async () => {
  const first = await capture(recycledCellSnapshot('First story'));
  const second = await capture(recycledCellSnapshot('First story'));
  assert.ok(first.fingerprint);
  assert.equal(first.fingerprint, second.fingerprint);
});
