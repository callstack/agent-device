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
