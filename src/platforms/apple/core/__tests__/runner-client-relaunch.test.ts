import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { mockStopIosRunnerSession } = vi.hoisted(() => ({
  mockStopIosRunnerSession: vi.fn(async () => {}),
}));

vi.mock('../runner/runner-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runner/runner-session.ts')>()),
  stopIosRunnerSession: mockStopIosRunnerSession,
}));

import type { DeviceInfo } from '../../../../kernel/device.ts';
import {
  type AppleRunnerCommandExecutor,
  withAppleRunnerProvider,
} from '../runner/runner-provider.ts';
import { notifyIosRunnerAppRelaunched } from '../runner/runner-client.ts';

const iosSimulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

beforeEach(() => {
  vi.resetAllMocks();
});

test('notifies the retained runner that an external app relaunch replaced its target', async () => {
  const runCommand = vi.fn<AppleRunnerCommandExecutor>(async () => ({}));

  await withAppleRunnerProvider(runCommand, { deviceId: iosSimulator.id }, async () => {
    await notifyIosRunnerAppRelaunched(iosSimulator);
  });

  assert.equal(runCommand.mock.calls.length, 1);
  assert.equal(runCommand.mock.calls[0]?.[1].command, 'targetReset');
  assert.equal(mockStopIosRunnerSession.mock.calls.length, 0);
});

test('discards the retained runner when target reset cannot be confirmed', async () => {
  const runCommand = vi.fn<AppleRunnerCommandExecutor>(async () => {
    throw new Error('runner transport failed');
  });

  await withAppleRunnerProvider(runCommand, { deviceId: iosSimulator.id }, async () => {
    await notifyIosRunnerAppRelaunched(iosSimulator);
  });

  assert.deepEqual(mockStopIosRunnerSession.mock.calls, [[iosSimulator.id]]);
});
