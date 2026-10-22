import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { IOS_SYSTEM_SURFACE_HOSTS } from '@agent-device/contracts/ios-system-surface';

const runner = vi.hoisted(() => ({
  readRunnerSessionLiveness: vi.fn(),
  runAppleRunnerCommand: vi.fn(),
}));
vi.mock('./core/runner-client.ts', () => runner);

import { createSystemSurfaceForegroundProbe } from './system-surface-foreground.ts';

const ios = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-1',
  name: 'iPhone',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;

const [safari, passbook] = IOS_SYSTEM_SURFACE_HOSTS.map((host) => host.bundleId);

beforeEach(() => {
  runner.readRunnerSessionLiveness.mockReset();
  runner.runAppleRunnerCommand.mockReset();
  runner.readRunnerSessionLiveness.mockReturnValue({ sessionId: 'runner-1', liveness: 'ready' });
});

function statesByHost(states: Record<string, unknown>) {
  runner.runAppleRunnerCommand.mockImplementation(async (_device, command) => ({
    applicationState: states[command.appBundleId],
  }));
}

function probe() {
  return createSystemSurfaceForegroundProbe()(ios, {
    signal: new AbortController().signal,
    requestId: 'req-1',
  });
}

test('every registered host off screen is background, read only from the ready runner session', async () => {
  statesByHost({ [safari!]: 'runningBackgroundSuspended', [passbook!]: 'notRunning' });

  await expect(probe()).resolves.toBe('background');
  expect(
    runner.runAppleRunnerCommand.mock.calls.map(([, command, options]) => [command, options]),
  ).toEqual(
    [safari, passbook].map((bundleId) => [
      { command: 'appState', appBundleId: bundleId },
      expect.objectContaining({ expectedRunnerSessionId: 'runner-1', requestId: 'req-1' }),
    ]),
  );
});

test('one background host does not hide another one presenting', async () => {
  statesByHost({ [safari!]: 'runningBackground', [passbook!]: 'runningForeground' });

  await expect(probe()).resolves.toEqual({
    kind: 'foreground',
    host: IOS_SYSTEM_SURFACE_HOSTS.find((host) => host.bundleId === passbook),
  });
});

test.for([
  ['no runner session', null],
  ['a runner still starting', { sessionId: 'runner-1', liveness: 'starting' }],
] as const)('%s is unknown and sends no command', async ([, liveness]) => {
  runner.readRunnerSessionLiveness.mockReturnValue(liveness);

  await expect(probe()).resolves.toBe('unknown');
  expect(runner.runAppleRunnerCommand).not.toHaveBeenCalled();
});

test.for([
  ['an unknown state', 'unknown'],
  ['an undeclared state', 'suspendedSomehow'],
  ['no state', undefined],
] as const)('%s is unknown', async ([, state]) => {
  statesByHost({ [safari!]: state, [passbook!]: 'notRunning' });

  await expect(probe()).resolves.toBe('unknown');
});

test('a failed read is unknown, and a cancelled request still cancels', async () => {
  runner.runAppleRunnerCommand.mockRejectedValue(new Error('runner unreachable'));
  await expect(probe()).resolves.toBe('unknown');

  const controller = new AbortController();
  controller.abort(new Error('request cancelled'));
  await expect(
    createSystemSurfaceForegroundProbe()(ios, { signal: controller.signal }),
  ).rejects.toThrow('request cancelled');
});
