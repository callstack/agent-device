import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isNewerVersion } from './version.ts';

test('isNewerVersion orders release versions numerically per segment', () => {
  assert.equal(isNewerVersion('0.21.6', '0.20.8'), true);
  assert.equal(isNewerVersion('0.21.12', '0.21.6'), true);
  assert.equal(isNewerVersion('1.0.0', '0.21.12'), true);
  assert.equal(isNewerVersion('0.20.8', '0.21.6'), false);
  assert.equal(isNewerVersion('0.21.6', '0.21.6'), false);
});
