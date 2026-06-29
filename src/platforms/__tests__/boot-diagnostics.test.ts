import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bootFailureHint, classifyBootFailure } from '../boot-diagnostics.ts';
import { AppError } from '../../kernel/errors.ts';

test('classifyBootFailure maps timeout errors', () => {
  const reason = classifyBootFailure({
    message: 'bootstatus timed out after 120s',
    context: { platform: 'ios', phase: 'boot' },
  });
  assert.equal(reason, 'IOS_BOOT_TIMEOUT');
});

test('classifyBootFailure maps adb offline errors', () => {
  const reason = classifyBootFailure({
    stderr: 'error: device offline',
    context: { platform: 'android', phase: 'transport' },
  });
  assert.equal(reason, 'ADB_TRANSPORT_UNAVAILABLE');
});

test('classifyBootFailure maps tool missing from AppError code (android)', () => {
  const reason = classifyBootFailure({
    error: new AppError('TOOL_MISSING', 'adb not found in PATH'),
    context: { platform: 'android', phase: 'transport' },
  });
  assert.equal(reason, 'ADB_TRANSPORT_UNAVAILABLE');
});

test('classifyBootFailure maps tool missing from AppError code (ios)', () => {
  const reason = classifyBootFailure({
    error: new AppError('TOOL_MISSING', 'xcrun not found in PATH'),
    context: { platform: 'ios', phase: 'boot' },
  });
  assert.equal(reason, 'IOS_TOOL_MISSING');
});

test('classifyBootFailure reads stderr from AppError details', () => {
  const reason = classifyBootFailure({
    error: new AppError('COMMAND_FAILED', 'adb failed', {
      stderr: 'error: device unauthorized',
    }),
    context: { platform: 'android', phase: 'transport' },
  });
  assert.equal(reason, 'ADB_TRANSPORT_UNAVAILABLE');
});

test('bootFailureHint returns actionable guidance', () => {
  const hint = bootFailureHint('IOS_RUNNER_CONNECT_TIMEOUT');
  assert.equal(hint.includes('xcodebuild logs'), true);
});

test('connect phase does not classify non-timeout errors as connect timeout', () => {
  const reason = classifyBootFailure({
    message: 'Runner returned malformed JSON payload',
    context: { platform: 'ios', phase: 'connect' },
  });
  assert.equal(reason, 'BOOT_COMMAND_FAILED');
});
