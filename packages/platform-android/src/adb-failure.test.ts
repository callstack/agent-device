import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  androidAdbResultError,
  androidDiscoveryCommandError,
  attachAdbFailureHint,
  attachAndroidHelperInstallTimeoutHint,
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

test('only the bare host adb device-offline refusal is classified as a host refusal', () => {
  for (const stderr of ['adb: device offline\n', "error: device 'emulator-5554' offline"]) {
    assert.deepEqual(classifyAndroidAdbFailure(stderr), {
      reason: 'device_offline',
      hint: 'The device is connected but offline — wait for it to finish booting or run adb reconnect, then retry.',
      retriable: true,
      hostRefusal: true,
    });
  }
  for (const [stderr, stdout] of [
    ['adb: device offline', 'partial'],
    ['flash: device offline, giving up', ''],
  ] as const) {
    const failure = classifyAndroidAdbFailure(stderr, stdout);
    assert.equal(failure?.reason, 'device_offline');
    assert.equal(failure?.hostRefusal, undefined);
  }

  const refused = attachAdbFailureHint(
    new AppError('COMMAND_FAILED', 'adb exited with code 1', { stderr: 'adb: device offline' }),
  );
  assert.equal(refused.details?.adbHostRefusal, true);
  const timedOut = attachAdbFailureHint(
    new AppError('COMMAND_FAILED', 'adb timed out after 10ms', {
      stderr: 'adb: device offline',
      timeoutMs: 10,
    }),
  );
  assert.equal(timedOut.details?.adbFailure, 'timeout');
  assert.equal(Object.hasOwn(timedOut.details ?? {}, 'adbHostRefusal'), false);
});

const HOST_REFUSALS = [
  ['device_unauthorized', 'error: device unauthorized.'],
  ['device_offline', 'error: device offline'],
  ['multiple_devices', 'error: more than one device/emulator'],
  ['no_devices', 'adb: no devices/emulators found'],
  ['device_not_found', "error: device 'emulator-5554' not found"],
] as const;

const DEVICE_SIDE_FAILURES = [
  ['connection_dropped', 'adb: error: protocol fault', ''],
  ['install_insufficient_storage', '', 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]'],
  ['install_update_incompatible', '', 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]'],
  ['install_version_downgrade', '', 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]'],
  ['install_failed', '', 'Failure [INSTALL_FAILED_DEXOPT]'],
] as const;

test('every host-refusal reason is classified hostRefusal and stamped as adbHostRefusal', () => {
  for (const [reason, stderr] of HOST_REFUSALS) {
    assert.equal(classifyAndroidAdbFailure(stderr)?.reason, reason);
    assert.equal(classifyAndroidAdbFailure(stderr)?.hostRefusal, true, reason);
    const error = attachAdbFailureHint(
      new AppError('COMMAND_FAILED', 'adb exited with code 1', { stderr }),
    );
    assert.equal(error.details?.adbFailure, reason);
    assert.equal(error.details?.adbHostRefusal, true, reason);
  }
});

test('refusal text never proves a refusal unless it is the entire adb output', () => {
  for (const [reason, refusal] of HOST_REFUSALS) {
    for (const [stderr, stdout] of [
      [refusal, 'partial'],
      [`${refusal}\nKilled`, ''],
      [`adb server version (40) doesn't match this client (41); killing...\n${refusal}`, ''],
      [`${refusal}, giving up`, ''],
    ] as const) {
      const failure = classifyAndroidAdbFailure(stderr, stdout);
      assert.equal(failure?.hostRefusal, undefined, `${reason}: ${stderr} | ${stdout}`);
      const error = attachAdbFailureHint(
        new AppError('COMMAND_FAILED', 'adb exited with code 1', { stderr, stdout }),
      );
      assert.equal(Object.hasOwn(error.details ?? {}, 'adbHostRefusal'), false, reason);
    }
  }
  const mismatch = classifyAndroidAdbFailure(
    "adb server version (40) doesn't match this client (41); killing...",
  );
  assert.equal(mismatch?.reason, 'server_version_mismatch');
  assert.equal(mismatch?.hostRefusal, undefined);
});

test('reasons a device-side command can produce are never classified hostRefusal', () => {
  for (const [reason, stderr, stdout] of DEVICE_SIDE_FAILURES) {
    const failure = classifyAndroidAdbFailure(stderr, stdout);
    assert.equal(failure?.reason, reason);
    assert.equal(failure?.hostRefusal, undefined, reason);
    const error = attachAdbFailureHint(
      new AppError('COMMAND_FAILED', 'adb exited with code 1', { stderr, stdout }),
    );
    assert.equal(Object.hasOwn(error.details ?? {}, 'adbHostRefusal'), false, reason);
  }
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

test('attachAndroidHelperInstallTimeoutHint names the OEM install dialog, not a wedged server', () => {
  const helperInstallTimeout = attachAndroidHelperInstallTimeoutHint(
    attachAdbFailureHint(
      new AppError('COMMAND_FAILED', 'adb timed out after 30000ms', {
        timeoutMs: 30_000,
        stdout: '',
        stderr: '',
      }),
    ),
  );
  assert.equal(helperInstallTimeout.details?.adbFailure, 'timeout');
  assert.match(String(helperInstallTimeout.details?.hint), /install-confirmation dialog/);
  assert.doesNotMatch(String(helperInstallTimeout.details?.hint), /wedged/);

  // The helper hint is scoped to helper installs: any other adb timeout keeps the
  // generic advice, because nothing at that call site knows about a package installer.
  const shellTimeout = attachAdbFailureHint(
    new AppError('COMMAND_FAILED', 'adb timed out after 5000ms', { timeoutMs: 5000 }),
  );
  assert.match(String(shellTimeout.details?.hint), /wedged/);

  // Only a timeout is rewritten: an exit-coded install rejection keeps its own classification,
  // and anything that is not a COMMAND_FAILED AppError passes through untouched.
  const installRejection = attachAndroidHelperInstallTimeoutHint(
    new AppError('COMMAND_FAILED', 'adb install rejected', { stderr: 'device offline' }),
  );
  assert.equal(installRejection.details?.adbFailure, undefined);
  assert.equal(installRejection.details?.hint, undefined);

  // A hint curated nearer the failure — a provider's own advice — outranks this heuristic.
  const curated = attachAndroidHelperInstallTimeoutHint(
    new AppError('COMMAND_FAILED', 'adb timed out after 30000ms', {
      timeoutMs: 30_000,
      hint: 'the cloud session expired',
    }),
  );
  assert.equal(curated.details?.hint, 'the cloud session expired');

  const unsupported = new AppError('UNSUPPORTED_OPERATION', 'helper unavailable', {
    timeoutMs: 30_000,
  });
  assert.equal(attachAndroidHelperInstallTimeoutHint(unsupported), unsupported);
  assert.equal(attachAndroidHelperInstallTimeoutHint('adb install failed'), 'adb install failed');
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
