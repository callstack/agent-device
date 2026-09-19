import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { makeBackgroundRunner } from './runner-session-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { launchRunnerProcess } from '../runner-process-launch.ts';

const mockRunCmdBackground = vi.fn();

beforeEach(() => {
  appleRunnerTestHost.update({ runCmdBackground: mockRunCmdBackground });
});

test('runner process launch exposes the listener-ready marker from xcodebuild output', async () => {
  const background = {
    ...makeBackgroundRunner(4242),
    wait: new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => {}),
  };
  mockRunCmdBackground.mockReturnValue(background);

  const launched = await launchRunnerProcess({
    device: IOS_SIMULATOR,
    port: 8123,
    xctestrunPath: '/tmp/runner.xctestrun',
    derivedPath: '/tmp/runner-derived',
  });
  background.child.stderr.emit('data', 'AGENT_DEVICE_RUNNER_LISTENER_');
  background.child.stderr.emit('data', 'READY');
  assert.equal(launched.startupRetryWake.aborted, true);

  assert.equal(mockRunCmdBackground.mock.calls[0]?.[0], 'xcodebuild');
  const args = mockRunCmdBackground.mock.calls[0]?.[1] as string[];
  assert.equal(args[args.indexOf('-xctestrun') + 1], '/tmp/runner.xctestrun');
  assert.equal(args[args.indexOf('-derivedDataPath') + 1], '/tmp/runner-derived');
  assert.equal(mockRunCmdBackground.mock.calls[0]?.[2]?.env?.AGENT_DEVICE_RUNNER_PORT, '8123');
});

test('runner process exit wakes startup probing without a listener marker', async () => {
  let rejectProcessExit: (reason?: unknown) => void = () => assert.fail('missing process wait');
  const processExit = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (_resolve, reject) => {
      rejectProcessExit = reject;
    },
  );
  mockRunCmdBackground.mockReturnValue({
    ...makeBackgroundRunner(4242),
    wait: processExit,
  });

  const launched = launchRunnerProcess({
    device: IOS_SIMULATOR,
    port: 8123,
    xctestrunPath: '/tmp/runner.xctestrun',
    derivedPath: '/tmp/runner-derived',
  });
  rejectProcessExit(new Error('xcodebuild exited'));
  await Promise.resolve();

  assert.equal(launched.startupRetryWake.aborted, true);
});

test('the runner is spawned detached, which is what a handoff across daemons rests on', async () => {
  mockRunCmdBackground.mockReturnValue(makeBackgroundRunner(4242));

  launchRunnerProcess({
    device: IOS_SIMULATOR,
    port: 8123,
    xctestrunPath: '/tmp/runner.xctestrun',
    derivedPath: '/tmp/runner-derived',
  });

  assert.equal(mockRunCmdBackground.mock.calls[0]?.[2]?.detached, true);
});

test('ending output observation stops the ready marker and releases both pipes', async () => {
  // The handoff calls this instead of letting the pipes close at process exit, so a runner that
  // cannot survive a write dies where the shutdown can still refuse it (#2681).
  const background = {
    ...makeBackgroundRunner(4242),
    wait: new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => {}),
  };
  mockRunCmdBackground.mockReturnValue(background);

  const launched = launchRunnerProcess({
    device: IOS_SIMULATOR,
    port: 8123,
    xctestrunPath: '/tmp/runner.xctestrun',
    derivedPath: '/tmp/runner-derived',
  });
  launched.endOutputObservation();
  background.child.stderr.emit('data', 'AGENT_DEVICE_RUNNER_LISTENER_READY');

  assert.equal(launched.startupRetryWake.aborted, false);
  assert.equal(background.child.stdout.destroy.mock.calls.length, 1);
  assert.equal(background.child.stderr.destroy.mock.calls.length, 1);
});
