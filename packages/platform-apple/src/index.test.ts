import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildAppNotInstalledError } from '@agent-device/platform-apple/app-resolution';
import { createLocalAppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import * as appleRoot from './index.ts';

test('Apple root exposes composition only', () => {
  assert.deepEqual(Object.keys(appleRoot).sort(), [
    'applePlugin',
    'inventoryModule',
    'loadShutdownRuntime',
    'runtimeModule',
  ]);
});

test('lazy Apple tool provider preserves the local semantic operation shape', () => {
  const provider = createLocalAppleToolProvider();

  assert.equal(typeof provider.runCommand, 'function');
  assert.equal(typeof provider.whichCommand, 'function');
  assert.equal(typeof provider.simctl.run, 'function');
  assert.equal(typeof provider.devicectl.run, 'function');
  assert.equal(typeof provider.plist?.readJson, 'function');
  // The local macOS host routes belong to the installed macOS leaf, not to this provider.
  assert.equal(provider.macosHost, undefined);
});

test('Apple app resolution facade preserves its synchronous helper contract', () => {
  const appError = buildAppNotInstalledError('Shoply');

  assert.equal(appError.code, 'APP_NOT_INSTALLED');
  assert.equal(appError instanceof Promise, false);
});
