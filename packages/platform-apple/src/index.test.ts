import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLocalAppleToolProvider } from './index.ts';

test('lazy Apple tool provider preserves the local semantic operation shape', () => {
  const provider = createLocalAppleToolProvider();

  assert.equal(typeof provider.runCommand, 'function');
  assert.equal(typeof provider.whichCommand, 'function');
  assert.equal(typeof provider.simctl?.run, 'function');
  assert.equal(typeof provider.devicectl?.run, 'function');
  assert.equal(typeof provider.plist?.readJson, 'function');
  assert.equal(typeof provider.macosHost?.openBundle, 'function');
  assert.equal(typeof provider.macosHost?.listApps, 'function');
});
