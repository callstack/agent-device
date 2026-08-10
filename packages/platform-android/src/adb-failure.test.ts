import assert from 'node:assert/strict';
import { test } from 'vitest';
import { androidDiscoveryCommandError, classifyAndroidAdbFailure } from './adb-failure.ts';

test('ADB failure classification keeps transport on stderr and install verdicts on stdout', () => {
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

test('ADB discovery classifies transport failures from stderr without trusting stdout', () => {
  const stdoutOnly = androidDiscoveryCommandError(
    'adb devices failed',
    { stdout: 'error: device offline', stderr: '', exitCode: 1 },
    'fallback',
  );
  const versionMismatch = androidDiscoveryCommandError(
    'adb devices failed',
    {
      stdout: '',
      stderr: "adb server version (40) doesn't match this client (41); killing...",
      exitCode: 1,
    },
    'fallback',
  );

  assert.equal(stdoutOnly.details?.adbFailure, undefined);
  assert.equal(stdoutOnly.details?.retriable, undefined);
  assert.equal(stdoutOnly.details?.hint, 'fallback');
  assert.equal(versionMismatch.details?.adbFailure, 'server_version_mismatch');
  assert.equal(versionMismatch.details?.retriable, true);
  assert.match(String(versionMismatch.details?.hint), /Multiple adb installs conflict/);
});
