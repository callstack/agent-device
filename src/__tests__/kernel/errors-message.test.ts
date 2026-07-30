import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError, normalizeError } from '@agent-device/kernel/errors';

// maybeEnrichCommandFailedMessage / firstStderrLine: how normalizeError turns a
// raw process-exit stderr blob into (or leaves alone) the reported message.

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
  const err = new AppError('COMMAND_FAILED', 'Android snapshot helper did not return XML', {
    exitCode: 1,
    processExitError: true,
    stderr: 'instrumentation unavailable\n',
  });
  const normalized = normalizeError(err);
  assert.equal(
    normalized.message,
    'Android snapshot helper did not return XML: instrumentation unavailable',
  );
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

// maybeEnrichCommandFailedMessage: gating conditions.

test('normalizeError does not enrich the message for a non-COMMAND_FAILED code, even with processExitError/stderr present', () => {
  const err = new AppError('DEVICE_NOT_FOUND', 'device vanished', {
    processExitError: true,
    stderr: 'some completely different stderr text',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'device vanished');
});

test('normalizeError does not enrich a COMMAND_FAILED message when processExitError is absent', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'xcrun exited with code 1');
});

test('normalizeError does not enrich a COMMAND_FAILED message when processExitError is exactly false', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    processExitError: false,
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'xcrun exited with code 1');
});

test('normalizeError ignores a non-string details.stderr value rather than enriching the message with it', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    processExitError: true,
    stderr: 12345 as unknown as string,
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'xcrun exited with code 1');
});

test('normalizeError leaves the message unchanged when stderr yields no usable excerpt', () => {
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    processExitError: true,
    // Every line is blank or matches a skip pattern, so firstStderrLine finds nothing.
    stderr: '\n  \nAn error was encountered processing the command (domain=X, code=1):\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'simctl boot failed');
});

// GENERIC_EXIT_MESSAGE boundary: pins `^\S+ exited with code -?\d+$` exactly —
// a single tool token, an optional leading minus, and nothing after the digits.

test('normalizeError replaces (rather than appends) for a generic exit message with a negative exit code', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code -1', {
    processExitError: true,
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'Operation not permitted');
});

test('normalizeError appends (rather than replaces) when trailing text follows the exit code', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1 (signal 0)', {
    processExitError: true,
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'xcrun exited with code 1 (signal 0): Operation not permitted');
});

test('normalizeError appends (rather than replaces) when the exit code is non-numeric', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code abc', {
    processExitError: true,
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'xcrun exited with code abc: Operation not permitted');
});

test('normalizeError appends (rather than replaces) when the tool token itself contains whitespace', () => {
  const err = new AppError('COMMAND_FAILED', 'my tool exited with code 1', {
    processExitError: true,
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'my tool exited with code 1: Operation not permitted');
});

// STDERR_NOISE_PREFIX boundary: the adb/xcrun/simctl and "error:" groups each
// consume only whitespace (`\s*`), never greedily eating adjacent non-whitespace
// content, and each group is independently optional.

test('normalizeError strips only the adb/xcrun/simctl token, not adjacent non-whitespace content that follows it directly', () => {
  const err = new AppError('COMMAND_FAILED', 'adb exited with code 1', {
    processExitError: true,
    stderr: 'adb:deviceOffline still not ready\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'deviceOffline still not ready');
});

test('normalizeError strips a zero-space "error:" prefix without requiring or over-consuming whitespace', () => {
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    processExitError: true,
    stderr: 'error:immediate text\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'simctl boot failed: immediate text');
});

test('normalizeError trims each stderr line before prefix-matching, so leading whitespace cannot defeat the anchored noise-prefix regex', () => {
  // The leading-whitespace line must NOT be the string's first/last line: the
  // whole `details.stderr` value is `.trim()`-ed once by redaction before
  // firstStderrLine ever sees it, which would otherwise erase exactly the
  // whitespace this test needs to keep. A real skip-pattern line ahead of it
  // keeps that whitespace internal to the string.
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    processExitError: true,
    stderr:
      'An error was encountered processing the command (domain=X):\n' +
      '  error: leading whitespace line\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'simctl boot failed: leading whitespace line');
});

// firstStderrLine truncates an excerpt over 200 characters; pin both sides of
// that boundary explicitly since a passing-but-short-excerpt test can never
// exercise it.

test('normalizeError truncates a stderr excerpt over 200 characters and appends an ellipsis', () => {
  const longLine = 'x'.repeat(250);
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    processExitError: true,
    stderr: `${longLine}\n`,
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, `simctl boot failed: ${'x'.repeat(200)}...`);
});

test('normalizeError leaves a stderr excerpt of exactly 200 characters untruncated', () => {
  const exactLine = 'y'.repeat(200);
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    processExitError: true,
    stderr: `${exactLine}\n`,
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, `simctl boot failed: ${exactLine}`);
});
