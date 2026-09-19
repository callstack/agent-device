import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
import { assertDevToolsSecurityForIosRunner } from '../runner-dev-tools-security.ts';
import { IOS_DEVICE, IOS_SIMULATOR } from './device-fixtures.ts';
import { RUNNER_STARTUP_FAILURE_FIXTURES } from './runner-startup-failure-fixtures.ts';

/**
 * `DevToolsSecurity -status` answers for the Mac, not for the iPhone (#2680). The refusal this probe
 * threw used to carry a hint and no reason, so a caller could only match its wording — and that
 * wording is nearly the same as the device's own Developer Mode state, which is a different fact on
 * a different machine. These cases pin that the host refusal publishes the host's own reason, keyed
 * on the status it read rather than on the sentence it printed.
 */

const HOST_REFUSAL_FIXTURE = RUNNER_STARTUP_FAILURE_FIXTURES.find(
  (fixture) => fixture.reason === 'devtools_security_developer_mode_disabled',
);

const runAppleToolCommand = vi.fn();

beforeEach(() => {
  runAppleToolCommand.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  appleRunnerTestHost.update({ runAppleToolCommand });
});

test('the host DevToolsSecurity refusal publishes its own typed reason', async () => {
  assert.ok(HOST_REFUSAL_FIXTURE);
  mockDevToolsSecurityOutput(HOST_REFUSAL_FIXTURE.output);
  const expectedStatus = HOST_REFUSAL_FIXTURE.output.trim();

  await assert.rejects(
    () => assertDevToolsSecurityForIosRunner(IOS_DEVICE),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.message, /Developer mode is disabled/);
      assert.equal(error.details?.reason, 'devtools_security_developer_mode_disabled');
      assert.equal(error.details?.devToolsSecurityStatus, expectedStatus);

      // What the caller renders: hint at top level, reason in details.
      const envelope = normalizeError(error, { diagnosticId: 'diag-devtools-1' });
      assert.match(String(envelope.hint), /DevToolsSecurity -enable/);
      assert.equal(envelope.diagnosticId, 'diag-devtools-1');
      assert.equal(envelope.details?.hint, undefined);
      assert.equal(envelope.details?.diagnosticId, undefined);
      assert.equal(envelope.details?.reason, 'devtools_security_developer_mode_disabled');
      return true;
    },
  );
});

test('an enabled host developer mode is not a failure', async () => {
  mockDevToolsSecurityOutput('Developer mode is currently enabled for development tools.\n');

  await assert.doesNotReject(() => assertDevToolsSecurityForIosRunner(IOS_DEVICE));
});

test('a simulator never takes the host probe', async () => {
  mockDevToolsSecurityOutput('Developer mode is currently disabled.\n');

  await assert.doesNotReject(() => assertDevToolsSecurityForIosRunner(IOS_SIMULATOR));

  assert.equal(
    runAppleToolCommand.mock.calls.some((call) => call[0] === 'DevToolsSecurity'),
    false,
  );
});

function mockDevToolsSecurityOutput(stdout: string): void {
  runAppleToolCommand.mockImplementation(async (cmd: string) => ({
    exitCode: 0,
    stdout: cmd === 'DevToolsSecurity' ? stdout : '',
    stderr: '',
  }));
}
