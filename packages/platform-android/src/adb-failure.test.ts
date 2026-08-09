import assert from 'node:assert/strict';
import { test } from 'vitest';
import { androidDiscoveryCommandError } from './adb-failure.ts';

test('ADB failure classification considers stdout as well as stderr', () => {
  const error = androidDiscoveryCommandError(
    'adb devices failed',
    { stdout: 'error: device offline', stderr: '', exitCode: 1 },
    'fallback',
  );

  assert.equal(error.details?.adbFailure, 'device_offline');
  assert.equal(error.details?.retriable, true);
  assert.match(String(error.details?.hint), /connected but offline/);
});
