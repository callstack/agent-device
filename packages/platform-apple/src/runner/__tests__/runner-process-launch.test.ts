import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { makeBackgroundRunner } from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { launchRunnerProcess } from '../runner-process-launch.ts';

const mockRunCmdBackground = vi.fn();

function runnerLogPath(): string {
  return path.join(mkdtempForTestSync('runner-launch-'), 'runner.log');
}

beforeEach(() => {
  appleRunnerTestHost.update({ runCmdBackground: mockRunCmdBackground });
  mockRunCmdBackground.mockReset();
});

test("the runner is spawned detached onto its own log file, not onto this process's pipes", async () => {
  mockRunCmdBackground.mockReturnValue(makeBackgroundRunner(4242));

  launchRunnerProcess({
    device: IOS_SIMULATOR,
    port: 8123,
    xctestrunPath: '/tmp/runner.xctestrun',
    derivedPath: '/tmp/runner-derived',
    logPath: runnerLogPath(),
  });

  assert.equal(mockRunCmdBackground.mock.calls[0]?.[0], 'xcodebuild');
  const options = mockRunCmdBackground.mock.calls[0]?.[2] as {
    detached?: boolean;
    stdio?: (string | number)[];
    captureOutput?: boolean;
    env?: NodeJS.ProcessEnv;
  };
  // A detached runner that outlives this daemon must not hold a pipe this daemon can close under it:
  // SIGPIPE would then arrive on the runner's next write, minutes into the next daemon's session.
  assert.equal(options.detached, true);
  assert.equal(options.captureOutput, false);
  assert.equal(options.stdio?.[0], 'ignore');
  const [stdoutFd, stderrFd] = [options.stdio?.[1], options.stdio?.[2]];
  assert.equal(typeof stdoutFd, 'number');
  assert.equal(stdoutFd, stderrFd);
  assert.equal(options.env?.AGENT_DEVICE_RUNNER_PORT, '8123');

  const args = mockRunCmdBackground.mock.calls[0]?.[1] as string[];
  assert.equal(args[args.indexOf('-xctestrun') + 1], '/tmp/runner.xctestrun');
  assert.equal(args[args.indexOf('-derivedDataPath') + 1], '/tmp/runner-derived');
});

test('test-without-building resolves a scoped-set simulator in its own set', () => {
  mockRunCmdBackground.mockReturnValue(makeBackgroundRunner(4242));

  for (const simulatorSetPath of ['/tmp/tenant-a/simulators', undefined]) {
    launchRunnerProcess({
      device: { ...IOS_SIMULATOR, simulatorSetPath },
      port: 8123,
      xctestrunPath: '/tmp/runner.xctestrun',
      derivedPath: '/tmp/runner-derived',
      logPath: runnerLogPath(),
    });
  }

  const [scopedArgs, defaultArgs] = mockRunCmdBackground.mock.calls.map(
    (call) => call[1] as string[],
  );
  assert.ok(scopedArgs?.includes('-DVTSimulatorSetLocation=/tmp/tenant-a/simulators'));
  assert.equal(
    scopedArgs?.[scopedArgs.indexOf('-destination') + 1],
    'platform=iOS Simulator,id=sim-1',
  );
  assert.equal(
    defaultArgs?.some((arg) => arg.startsWith('-DVTSimulatorSetLocation')),
    false,
  );
});

test('the listener-ready marker is read back from the runner log file', async () => {
  const logPath = runnerLogPath();
  mockRunCmdBackground.mockReturnValue({
    ...makeBackgroundRunner(4242),
    wait: new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => {}),
  });

  const launched = launchRunnerProcess({
    device: IOS_SIMULATOR,
    port: 8123,
    xctestrunPath: '/tmp/runner.xctestrun',
    derivedPath: '/tmp/runner-derived',
    logPath,
  });
  // What a real xcodebuild does: append to the file its descriptor points at.
  fs.appendFileSync(logPath, 'AGENT_DEVICE_RUNNER_LISTENER_');
  await waitFor(() => assert.equal(launched.startupRetryWake.aborted, false));
  fs.appendFileSync(logPath, 'READY\n');

  await waitFor(() => assert.equal(launched.startupRetryWake.aborted, true));
});

test('output an older runner generation left in the same log file does not wake startup', async () => {
  const logPath = runnerLogPath();
  fs.writeFileSync(logPath, 'AGENT_DEVICE_RUNNER_LISTENER_READY\n');
  mockRunCmdBackground.mockReturnValue({
    ...makeBackgroundRunner(4242),
    wait: new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => {}),
  });

  const launched = launchRunnerProcess({
    device: IOS_SIMULATOR,
    port: 8123,
    xctestrunPath: '/tmp/runner.xctestrun',
    derivedPath: '/tmp/runner-derived',
    logPath,
  });
  await waitFor(() => assert.equal(launched.startupRetryWake.aborted, false));

  assert.equal(launched.startupRetryWake.aborted, false);
});

test('a listener marker written during the spawn call still wakes startup', async () => {
  // A runner that reaches its listener can write before `runCmdBackground` hands the child back. The
  // generation offset has to come from the descriptor at open time, or that first line is already
  // below it and startup waits on a marker this generation actually printed (#2681).
  const logPath = runnerLogPath();
  mockRunCmdBackground.mockImplementation(() => {
    fs.appendFileSync(logPath, 'AGENT_DEVICE_RUNNER_LISTENER_READY\n');
    return {
      ...makeBackgroundRunner(4242),
      wait: new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => {}),
    };
  });

  const launched = launchRunnerProcess({
    device: IOS_SIMULATOR,
    port: 8123,
    xctestrunPath: '/tmp/runner.xctestrun',
    derivedPath: '/tmp/runner-derived',
    logPath,
  });

  await waitFor(() => assert.equal(launched.startupRetryWake.aborted, true));
});

test('a boot failure written during the spawn call is quotable from this generation', () => {
  // The same window seen from the other reader: the runner that dies instantly writes its failure
  // into it, and an error that could not quote those bytes ships a runner failure with an empty tail.
  const logPath = runnerLogPath();
  fs.writeFileSync(logPath, '** TEST EXECUTE FAILED ** of an older generation\n');
  mockRunCmdBackground.mockImplementation(() => {
    fs.appendFileSync(logPath, 'Failed to install embedded profile for the runner\n');
    return {
      ...makeBackgroundRunner(4242),
      wait: new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => {}),
    };
  });

  const launched = launchRunnerProcess({
    device: IOS_SIMULATOR,
    port: 8123,
    xctestrunPath: '/tmp/runner.xctestrun',
    derivedPath: '/tmp/runner-derived',
    logPath,
  });

  const quoted = launched.readLogTail(4_096);
  assert.match(quoted, /Failed to install embedded profile/);
  assert.doesNotMatch(quoted, /older generation/);
});

test('runner process exit wakes startup probing without a listener marker', async () => {
  let rejectProcessExit: (reason?: unknown) => void = () => assert.fail('missing process wait');
  const processExit = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (_resolve, reject) => {
      rejectProcessExit = reject;
    },
  );
  mockRunCmdBackground.mockReturnValue({ ...makeBackgroundRunner(4242), wait: processExit });

  const launched = launchRunnerProcess({
    device: IOS_SIMULATOR,
    port: 8123,
    xctestrunPath: '/tmp/runner.xctestrun',
    derivedPath: '/tmp/runner-derived',
    logPath: runnerLogPath(),
  });
  rejectProcessExit(new Error('xcodebuild exited'));
  await Promise.resolve();

  assert.equal(launched.startupRetryWake.aborted, true);
});

test("ending output observation stops the tail and closes this process's descriptor", async () => {
  const logPath = runnerLogPath();
  mockRunCmdBackground.mockReturnValue({
    ...makeBackgroundRunner(4242),
    wait: new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => {}),
  });

  const launched = launchRunnerProcess({
    device: IOS_SIMULATOR,
    port: 8123,
    xctestrunPath: '/tmp/runner.xctestrun',
    derivedPath: '/tmp/runner-derived',
    logPath,
  });
  const options = mockRunCmdBackground.mock.calls[0]?.[2] as { stdio: (string | number)[] };
  const logFd = options.stdio[1] as number;
  assert.equal(fs.fstatSync(logFd).size >= 0, true);

  launched.endOutputObservation();
  launched.endOutputObservation();

  // The runner keeps its own descriptor, so closing this process's copy is the whole handoff: no
  // signal is sent and nothing the runner writes later can fail (#2681).
  assert.throws(() => fs.fstatSync(logFd), /bad file descriptor|EBADF/);
  fs.appendFileSync(logPath, 'AGENT_DEVICE_RUNNER_LISTENER_READY\n');
  await waitFor(() => assert.equal(launched.startupRetryWake.aborted, false));
});

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) throw lastError;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
