import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { AppError } from '@agent-device/kernel/errors';
import type { ExecBackgroundResult } from '../host.ts';
import { buildRunnerEarlyExitError } from '../runner-contract.ts';
import { readRunnerLogTail } from '../runner-io.ts';
import type { RunnerSession } from '../runner-session-types.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

// Verbatim xcodebuild output from an iPhone that was not in the signing account.
// macOS localizes the installer prose, so the machine-readable anchors are the
// CoreDevice error code and the English framework strings around it.
const PROVISIONING_FAILURE_LOG = [
  'AgentDeviceRunnerUITests-Runner encountered an error (Failed to install or launch the test runner.',
  '(Underlying Error: Nie można zainstalować „AgentDeviceRunnerUITests-Runner”.',
  'Failed to install embedded profile for com.callstack.agentdevice.runner.uitests.xctrunner :',
  '0xe8008012 (This provisioning profile cannot be installed on this device.))))',
  '** TEST EXECUTE FAILED **',
].join('\n');

// Production shape since #2681: xcodebuild writes its own log file and the exec result carries only
// the exit code, so the file is what an early-exit error has to quote.
function sessionFailingWith(log: string): RunnerSession {
  const runnerLogPath = path.join(mkdtempForTestSync('runner-early-exit-'), 'runner.log');
  fs.writeFileSync(runnerLogPath, log);
  return {
    sessionId: 'early-exit-session',
    device: { platform: 'apple', id: 'device-1', name: 'iPhone', kind: 'device', booted: true },
    deviceId: 'device-1',
    port: 8100,
    xctestrunPath: '/tmp/runner.xctestrun',
    jsonPath: '/tmp/runner.json',
    runnerLogPath,
    readLogTail: (maxBytes) => readRunnerLogTail(runnerLogPath, maxBytes),
    testPromise: Promise.resolve({ exitCode: 1, stdout: '', stderr: '' }),
    child: { pid: 4242, exitCode: 1 } as ExecBackgroundResult['child'],
    state: 'starting',
    inFlightCommands: 0,
  };
}

test('the early-exit error a user actually receives names the provisioning cause', async () => {
  // Regression: the reason was classified correctly while the hint was built
  // separately and always returned connect-timeout guidance, so the shipped
  // error still told people to retry a runner that can never install.
  const error = (await buildRunnerEarlyExitError({
    session: sessionFailingWith(PROVISIONING_FAILURE_LOG),
    port: 8100,
  })) as AppError;

  assert.equal(error.details?.reason, 'IOS_RUNNER_DEVICE_NOT_PROVISIONED');
  const hint = String(error.details?.hint);
  assert.match(hint, /provisioning profile does not cover it/);
  assert.match(hint, /Register the device/);
  assert.doesNotMatch(hint, /Retry runner startup/);
  // Clearing derived data cannot register a device, so that advice is withheld.
  assert.doesNotMatch(hint, /clean:xcuitest/);
});

test('an ordinary early exit still gets connect-timeout and cache-recovery guidance', async () => {
  const error = (await buildRunnerEarlyExitError({
    session: sessionFailingWith('xcodebuild: error: Timed out waiting for the test runner'),
    port: 8100,
  })) as AppError;

  assert.equal(error.details?.reason, 'IOS_RUNNER_CONNECT_TIMEOUT');
  assert.match(String(error.details?.hint), /Retry runner startup/);
  assert.match(String(error.details?.hint), /clean:xcuitest/);
});

test('a busy connecting device keeps its own targeted hint', async () => {
  const error = (await buildRunnerEarlyExitError({
    session: sessionFailingWith('The device is busy: connecting to device'),
    port: 8100,
  })) as AppError;

  assert.match(String(error.details?.hint), /still connecting/);
});

test('the quoted tail is the end of the log, not its beginning', async () => {
  // A runner that retried for minutes writes far more than an error detail may carry; the anchors are
  // in what it said last, so a bound that kept the head would classify every boot as a timeout.
  const log = `${'Compiling swift module AgentDeviceRunnerUITests\n'.repeat(4_000)}${PROVISIONING_FAILURE_LOG}`;
  const error = (await buildRunnerEarlyExitError({
    session: sessionFailingWith(log),
    port: 8100,
  })) as AppError;

  assert.equal(error.details?.reason, 'IOS_RUNNER_DEVICE_NOT_PROVISIONED');
  const quoted = (error.details?.xcodebuild as { stderr?: string } | undefined)?.stderr ?? '';
  assert.ok(quoted.length <= 64 * 1024);
  assert.match(quoted, /TEST EXECUTE FAILED/);
});
