import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isSimulatorLaunchFBSError,
  classifyLaunchFailure,
  launchFailureHint,
} from '../launch-diagnostics.ts';
import { AppError } from '../../../../kernel/errors.ts';

test('isSimulatorLaunchFBSError identifies FBS code=4 errors', () => {
  const error = new AppError('COMMAND_FAILED', 'xcrun exited with code 4', {
    exitCode: 4,
    stderr:
      'An error was encountered processing the command (domain=FBSOpenApplicationServiceErrorDomain, code=4):\nThe request to open "com.example.app" failed.',
  });
  assert.equal(isSimulatorLaunchFBSError(error), true);
});

test('isSimulatorLaunchFBSError rejects non-AppError', () => {
  assert.equal(isSimulatorLaunchFBSError(new Error('something')), false);
});

test('isSimulatorLaunchFBSError rejects wrong error code', () => {
  const error = new AppError('INVALID_ARGS', 'bad args', {
    exitCode: 4,
    stderr: 'FBSOpenApplicationServiceErrorDomain the request to open',
  });
  assert.equal(isSimulatorLaunchFBSError(error), false);
});

test('isSimulatorLaunchFBSError rejects wrong exit code', () => {
  const error = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    exitCode: 1,
    stderr: 'FBSOpenApplicationServiceErrorDomain the request to open',
  });
  assert.equal(isSimulatorLaunchFBSError(error), false);
});

test('isSimulatorLaunchFBSError rejects unrelated stderr', () => {
  const error = new AppError('COMMAND_FAILED', 'xcrun exited with code 4', {
    exitCode: 4,
    stderr: 'some other error message',
  });
  assert.equal(isSimulatorLaunchFBSError(error), false);
});

test('classifyLaunchFailure returns APP_NOT_INSTALLED when not installed', () => {
  assert.equal(classifyLaunchFailure({ installed: false }), 'APP_NOT_INSTALLED');
});

test('classifyLaunchFailure returns ARCH_MISMATCH when not simulator compatible', () => {
  assert.equal(
    classifyLaunchFailure({ installed: true, simulatorCompatible: false }),
    'ARCH_MISMATCH',
  );
});

test('classifyLaunchFailure returns PERSISTENT_LAUNCH_FAIL when compatible', () => {
  assert.equal(
    classifyLaunchFailure({ installed: true, simulatorCompatible: true }),
    'PERSISTENT_LAUNCH_FAIL',
  );
});

test('classifyLaunchFailure returns PERSISTENT_LAUNCH_FAIL when compatibility unknown', () => {
  assert.equal(classifyLaunchFailure({ installed: true }), 'PERSISTENT_LAUNCH_FAIL');
});

test('launchFailureHint returns actionable string for ARCH_MISMATCH', () => {
  const hint = launchFailureHint('ARCH_MISMATCH');
  assert.ok(hint.length > 0);
  assert.ok(hint.includes('simulator'));
});

test('launchFailureHint returns actionable string for APP_NOT_INSTALLED', () => {
  const hint = launchFailureHint('APP_NOT_INSTALLED');
  assert.ok(hint.length > 0);
  assert.ok(hint.includes('install'));
});

test('launchFailureHint returns actionable string for PERSISTENT_LAUNCH_FAIL', () => {
  const hint = launchFailureHint('PERSISTENT_LAUNCH_FAIL');
  assert.ok(hint.length > 0);
  assert.ok(hint.includes('crash logs') || hint.includes('reinstalling'));
});

test('launchFailureHint returns actionable string for UNKNOWN', () => {
  const hint = launchFailureHint('UNKNOWN');
  assert.ok(hint.length > 0);
});
