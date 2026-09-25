import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'vitest';
import type { AppError } from '@agent-device/kernel/errors';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import type { ExecBackgroundResult } from '@agent-device/host-kit/command';
import { buildRunnerEarlyExitError } from '../runner-startup-transport.ts';
import { readRunnerLogTail } from '../runner-io.ts';
import type { RunnerSession } from '../runner-session-types.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { STUBBED_APPLE_TOOLCHAIN, stubAppleToolchainProbes } from './apple-toolchain-fixtures.ts';
import {
  CAPTURED_LAUNCH_DESTINATION_NOT_FOUND_OUTPUT,
  CAPTURED_SCOPED_SIMULATOR,
} from './runner-startup-failure-fixtures.ts';

const toolchainProbe = stubAppleToolchainProbes();
beforeEach(resetAllProcessMemosForTests);

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
function sessionFailingWith(
  log: string,
  generationStartOffset = 0,
  startupDeviceStates?: RunnerSession['startupDeviceStates'],
): RunnerSession {
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
    readLogTail: (maxBytes) =>
      readRunnerLogTail({ logPath: runnerLogPath, startOffset: generationStartOffset }, maxBytes),
    testPromise: Promise.resolve({ exitCode: 1, stdout: '', stderr: '' }),
    child: { pid: 4242, exitCode: 1 } as ExecBackgroundResult['child'],
    state: 'starting',
    startupDeviceStates,
    inFlightCommands: 0,
    hasAbandonedCommands: false,
  };
}

const IMAGE_DOWN_STATES = {
  developerMode: 'enabled' as const,
  developerDiskImage: 'unavailable' as const,
  developerDiskImageHint: 'Unlock the iPhone so it can mount the developer disk image.',
};

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

test('a failure from an older runner generation is not quoted as this launch output', async () => {
  // The log is append-only across runner generations, so an unbounded tail reaches into whichever
  // runner failed last: a device unregistered months ago would keep handing its provisioning hint to
  // every later boot failure, however unrelated (#2681).
  const error = (await buildRunnerEarlyExitError({
    session: sessionFailingWith(
      `${PROVISIONING_FAILURE_LOG}\nxcodebuild: error: Timed out waiting for the test runner`,
      PROVISIONING_FAILURE_LOG.length + 1,
    ),
    port: 8100,
  })) as AppError;

  assert.equal(error.details?.reason, 'IOS_RUNNER_CONNECT_TIMEOUT');
  const quoted = (error.details?.xcodebuild as { stderr?: string } | undefined)?.stderr ?? '';
  assert.doesNotMatch(quoted, /provisioning profile/);
  assert.match(quoted, /Timed out waiting for the test runner/);
});

test('an early exit carries the disk-image state the device was read in (#2683)', async () => {
  // A locked iPhone lets the build finish and kills `xcodebuild test-without-building` instead, so
  // the startup build catch never runs and the readiness facts read before the build would be
  // dropped. Captured on hardware: this is the failure an image-down locked phone actually produces.
  const error = (await buildRunnerEarlyExitError({
    session: sessionFailingWith(
      'xcodebuild: error: Timed out waiting for the test runner',
      0,
      IMAGE_DOWN_STATES,
    ),
    port: 8100,
  })) as AppError;

  assert.equal(error.details?.developerDiskImage, 'unavailable');
});

test('an early exit that already names a cause keeps it, and only gains the fact (#2683)', async () => {
  const error = (await buildRunnerEarlyExitError({
    session: sessionFailingWith(
      'xcodebuild: error: Timed out waiting for the test runner',
      0,
      IMAGE_DOWN_STATES,
    ),
    port: 8100,
  })) as AppError;

  // The connect reason was proved by the tool output, so the device's image state is never allowed
  // to overwrite a claimed cause or swap the hint beside it.
  assert.equal(error.details?.reason, 'IOS_RUNNER_CONNECT_TIMEOUT');
  assert.match(String(error.details?.hint), /Retry runner startup/);
});

test('a session that never probed the device publishes no disk-image claim (#2683)', async () => {
  const error = (await buildRunnerEarlyExitError({
    session: sessionFailingWith('xcodebuild: error: Timed out waiting for the test runner'),
    port: 8100,
  })) as AppError;

  assert.equal('developerDiskImage' in (error.details ?? {}), false);
});

const SET_WITHOUT_UDID = CAPTURED_SCOPED_SIMULATOR.setWithoutUdid;

// An external xctestrun: the session carries no build of its own, so the Xcode it names comes from
// the toolchain the host selects.
function simulatorSessionFailingWith(log: string, simulatorSetPath?: string): RunnerSession {
  return {
    ...sessionFailingWith(log),
    device: {
      platform: 'apple',
      id: CAPTURED_SCOPED_SIMULATOR.udid,
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      appleOs: 'ios',
      booted: true,
      simulatorSetPath,
    },
    deviceId: CAPTURED_SCOPED_SIMULATOR.udid,
    xctestrunArtifact: {
      xctestrunPath: '/tmp/runner.xctestrun',
      derived: '/tmp/derived',
      cache: 'external',
      artifact: 'valid',
      buildMs: 0,
      xctestrunPathSource: 'external',
    },
  };
}

test('a scoped-set simulator whose destination is missing names its set and the Xcode', async () => {
  const error = (await buildRunnerEarlyExitError({
    session: simulatorSessionFailingWith(
      CAPTURED_LAUNCH_DESTINATION_NOT_FOUND_OUTPUT,
      SET_WITHOUT_UDID,
    ),
    port: 8100,
  })) as AppError;

  assert.equal(error.details?.reason, 'simulator_set_destination_not_found');
  assert.match(String(error.details?.hint), /-DVTSimulatorSetLocation/);
  assert.equal(error.details?.simulatorSetPath, SET_WITHOUT_UDID);
  assert.equal(error.details?.xcodeVersion, STUBBED_APPLE_TOOLCHAIN.xcodeVersion);
  assert.ok(
    error.message.endsWith(
      `simulator set ${SET_WITHOUT_UDID} with Xcode ${STUBBED_APPLE_TOOLCHAIN.xcodeVersion}`,
    ),
  );
});

test('a scoped-set destination error whose Xcode cannot be read still names the set', async () => {
  toolchainProbe.mockReturnValue({ exitCode: 1, stdout: '', stderr: 'xcode-select: error' });

  const error = (await buildRunnerEarlyExitError({
    session: simulatorSessionFailingWith(
      CAPTURED_LAUNCH_DESTINATION_NOT_FOUND_OUTPUT,
      SET_WITHOUT_UDID,
    ),
    port: 8100,
  })) as AppError;

  assert.equal(error.details?.reason, 'simulator_set_destination_not_found');
  assert.equal(error.details?.simulatorSetPath, SET_WITHOUT_UDID);
  assert.equal('xcodeVersion' in (error.details ?? {}), false);
  assert.ok(
    error.message.endsWith(`simulator set ${SET_WITHOUT_UDID} with Xcode (version unreadable)`),
  );
});

test('a default-set simulator early exit keeps its boot-failure reason', async () => {
  const error = (await buildRunnerEarlyExitError({
    session: simulatorSessionFailingWith(CAPTURED_LAUNCH_DESTINATION_NOT_FOUND_OUTPUT),
    port: 8100,
  })) as AppError;

  assert.equal(error.details?.reason, 'IOS_RUNNER_CONNECT_TIMEOUT');
  assert.equal(error.details?.simulatorSetPath, undefined);
});
