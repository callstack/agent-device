import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  androidAdbResultError,
  androidDiscoveryCommandError,
  attachAdbFailureHint,
  classifyAndroidAdbFailure,
} from './adb-failure.ts';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';

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

test('attachAdbFailureHint classifies timeouts first and never overwrites a site hint', () => {
  const timeout = attachAdbFailureHint(
    new AppError('COMMAND_FAILED', 'adb shell failed', {
      timeoutMs: 5000,
      stderr: 'transport error',
    }),
  );
  // Timeout wins over the retriable transport matcher: partial output is untrustworthy.
  assert.equal(timeout.details?.adbFailure, 'timeout');
  assert.equal(timeout.details?.retriable, undefined);

  const siteHint = attachAdbFailureHint(
    new AppError('COMMAND_FAILED', 'adb shell failed', {
      stderr: 'device offline',
      hint: 'site-provided',
    }),
  );
  assert.equal(siteHint.details?.adbFailure, 'device_offline');
  assert.equal(siteHint.details?.hint, 'site-provided');
  assert.equal(siteHint.details?.retriable, true);

  const foreign = new AppError('INVALID_ARGS', 'not an adb failure', { stderr: 'device offline' });
  assert.equal(attachAdbFailureHint(foreign).details?.adbFailure, undefined);
});

test('androidAdbResultError flags process exits but never a semantic exit-0 failure', () => {
  bindAndroidAdbHostStub();
  const nonzero = androidAdbResultError(
    'install failed',
    { exitCode: 1, stdout: 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]', stderr: '' },
    { packageName: 'a.b.c' },
  );
  assert.equal(nonzero.details?.processExitError, true);
  assert.equal(nonzero.details?.adbFailure, 'install_insufficient_storage');
  assert.equal(nonzero.details?.packageName, 'a.b.c');

  const semantic = androidAdbResultError('am start reported an error', {
    exitCode: 0,
    stdout: '',
    stderr: 'Error: activity not found',
  });
  assert.equal(semantic.details?.processExitError, undefined);
  assert.equal(semantic.details?.exitCode, 0);
});
