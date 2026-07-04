import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError, normalizeError, toAppErrorCode } from '../../kernel/errors.ts';

test('normalizeError adds default hint and strips diagnostic metadata from details', () => {
  const err = new AppError('COMMAND_FAILED', 'runner failed', {
    token: 'secret',
    hint: 'custom hint',
    diagnosticId: 'diag-1',
    logPath: '/tmp/diag.log',
    safe: 'ok',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.code, 'COMMAND_FAILED');
  assert.equal(normalized.message, 'runner failed');
  assert.equal(normalized.hint, 'custom hint');
  assert.equal(normalized.diagnosticId, 'diag-1');
  assert.equal(normalized.logPath, '/tmp/diag.log');
  assert.equal(normalized.details?.token, '[REDACTED]');
  assert.equal(normalized.details?.safe, 'ok');
  assert.equal(Object.hasOwn(normalized.details ?? {}, 'hint'), false);
});

test('normalizeError enriches generic command-failed message with stderr excerpt', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    exitCode: 1,
    processExitError: true,
    stderr: '\nOperation not permitted\nUnderlying error details',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'Operation not permitted');
});

test('normalizeError appends stderr excerpt to specific command-failed messages', () => {
  const err = new AppError('COMMAND_FAILED', 'uiautomator dump did not return XML', {
    exitCode: 1,
    processExitError: true,
    stderr: 'uiautomator unavailable\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'uiautomator dump did not return XML: uiautomator unavailable');
});

test('normalizeError does not duplicate an excerpt already present in the message', () => {
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed: device is locked', {
    exitCode: 1,
    processExitError: true,
    stderr: 'device is locked\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'simctl boot failed: device is locked');
});

test('normalizeError skips simctl boilerplate wrappers in stderr', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    exitCode: 1,
    processExitError: true,
    stderr: [
      'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=1):',
      'Simulator device failed to complete the requested operation.',
      'Operation not permitted',
      'Underlying error (domain=NSPOSIXErrorDomain, code=1):',
      '\tFailed to reset access',
      '\tOperation not permitted',
    ].join('\n'),
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'Operation not permitted');
});

test('normalizeError strips adb and severity prefixes from the stderr excerpt', () => {
  const err = new AppError('COMMAND_FAILED', 'adb exited with code 1', {
    exitCode: 1,
    processExitError: true,
    stderr: 'adb: error: failed to get feature set: device offline\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'failed to get feature set: device offline');
});

test('normalizeError strips a bare error prefix when appending to a curated message', () => {
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    exitCode: 1,
    processExitError: true,
    stderr: 'error: device is locked\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'simctl boot failed: device is locked');
});

test('normalizeError skips a stderr line that is only a noise prefix', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    exitCode: 1,
    processExitError: true,
    stderr: 'xcrun: error:\nunable to find utility simctl\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'unable to find utility simctl');
});

test('normalizeError provides app discovery guidance for app-not-installed errors', () => {
  const normalized = normalizeError(
    new AppError('APP_NOT_INSTALLED', 'No package found matching "chat"'),
  );
  assert.match(
    normalized.hint ?? '',
    /Run apps to discover the exact installed package or bundle id/i,
  );
});

test('normalizeError lifts details.retriable to the top level and strips it from details', () => {
  const normalized = normalizeError(
    new AppError('COMMAND_FAILED', 'adb exited with code 1', {
      stderr: 'error: device offline',
      retriable: true,
    }),
  );
  assert.equal(normalized.retriable, true);
  assert.equal(Object.hasOwn(normalized.details ?? {}, 'retriable'), false);
});

test('normalizeError omits retriable when the throw site did not classify it', () => {
  const normalized = normalizeError(new AppError('COMMAND_FAILED', 'adb exited with code 1'));
  assert.equal(Object.hasOwn(normalized, 'retriable'), false);
});

test('toAppErrorCode falls back when code is missing or empty', () => {
  assert.equal(toAppErrorCode(undefined), 'COMMAND_FAILED');
  assert.equal(toAppErrorCode(''), 'COMMAND_FAILED');
  assert.equal(toAppErrorCode(undefined, 'UNAUTHORIZED'), 'UNAUTHORIZED');
});
