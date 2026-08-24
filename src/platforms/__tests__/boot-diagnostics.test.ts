import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  bootFailureHint,
  classifyBootFailure,
  isInfrastructureBootFailureReason,
} from '../boot-diagnostics.ts';
import { AppError } from '@agent-device/kernel/errors';

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

test('classifies a runner install blocked by provisioning, not as a connect timeout', () => {
  // Real xcodebuild output from an iPhone that was not in the signing account.
  // The installer prose around it is localized by macOS, so only the CoreDevice
  // error code and the English framework strings can be matched.
  const stderr = [
    'AgentDeviceRunnerUITests-Runner encountered an error (Failed to install or launch the test runner.',
    '(Underlying Error: Nie można zainstalować „AgentDeviceRunnerUITests-Runner”.',
    'Failed to install embedded profile for com.callstack.agentdevice.runner.uitests.xctrunner :',
    '0xe8008012 (This provisioning profile cannot be installed on this device.)))',
    '** TEST EXECUTE FAILED **',
  ].join('\n');

  const reason = classifyBootFailure({
    message: 'Runner did not accept connection (xcodebuild exited early)',
    stderr,
    context: { platform: 'ios', phase: 'connect' },
  });

  assert.equal(reason, 'IOS_RUNNER_DEVICE_NOT_PROVISIONED');
  assert.match(bootFailureHint(reason), /provisioning profile does not cover it/);
  assert.match(bootFailureHint(reason), /Register the device/);
});

test('a provisioning failure is not treated as retryable infrastructure', () => {
  // Retrying cannot register a device with a signing team.
  assert.equal(isInfrastructureBootFailureReason('IOS_RUNNER_DEVICE_NOT_PROVISIONED'), false);
});

test('a live foreign runner owner is typed infrastructure', () => {
  assert.equal(isInfrastructureBootFailureReason('IOS_RUNNER_OWNED_BY_OTHER_DAEMON'), true);
  assert.match(bootFailureHint('IOS_RUNNER_OWNED_BY_OTHER_DAEMON'), /owning agent-device session/);
});

test.each([
  'Provisioning profile "Agent Device" has expired.',
  'Failed to install embedded profile: signing certificate is not valid.',
])('does not mistake an unrelated signing failure for an unregistered device: %s', (stderr) => {
  const reason = classifyBootFailure({
    message: 'Runner did not accept connection (xcodebuild exited early)',
    stderr,
    context: { platform: 'ios', phase: 'connect' },
  });

  assert.equal(reason, 'BOOT_COMMAND_FAILED');
});

test('still classifies a genuine runner connect timeout as such', () => {
  assert.equal(
    classifyBootFailure({
      message: 'Runner did not accept connection',
      context: { platform: 'ios', phase: 'connect' },
    }),
    'IOS_RUNNER_CONNECT_TIMEOUT',
  );
});
