import assert from 'node:assert/strict';
import { test } from 'vitest';
import { classifyAndroidAdbFailure } from './android-adb-failure.ts';

test('Android ADB failures keep transport on stderr and install verdicts on stdout', () => {
  assert.equal(
    classifyAndroidAdbFailure("adb server version (40) doesn't match this client (41); killing...")
      ?.reason,
    'server_version_mismatch',
  );
  assert.equal(classifyAndroidAdbFailure('', 'log line: device offline detected'), undefined);
  assert.equal(
    classifyAndroidAdbFailure('', 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]')?.reason,
    'install_update_incompatible',
  );
});
