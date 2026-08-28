import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildAppNotInstalledError } from '@agent-device/platform-apple/app-resolution';
import { resolveAppleBackRunnerCommand } from '@agent-device/platform-apple/interactions';
import { createLocalAppleToolProvider } from './index.ts';
import { buildSimctlArgs } from '@agent-device/platform-apple/simctl';

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

test('Apple domain facades preserve synchronous helper contracts', () => {
  const appError = buildAppNotInstalledError('Shoply');

  assert.equal(appError.code, 'APP_NOT_INSTALLED');
  assert.equal(resolveAppleBackRunnerCommand(), 'backInApp');
  assert.deepEqual(buildSimctlArgs(['list']), ['simctl', 'list']);
  assert.equal(appError instanceof Promise, false);
});
