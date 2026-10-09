import { beforeEach, expect, test, vi } from 'vitest';
import type { RunnerWarmLossNotice } from '@agent-device/platform-apple/runner/operations';

const NOTICE: RunnerWarmLossNotice = {
  reason: 'runner_destination_lost',
  deviceId: 'sim-1',
  sessionId: 'session-1',
  atMs: 1,
};

const mocks = vi.hoisted(() => ({
  takeRunnerWarmLossNotice: vi.fn(async (): Promise<RunnerWarmLossNotice | undefined> => undefined),
}));

vi.mock('@agent-device/platform-apple/runner/operations', () => mocks);

import { IOS_DEVICE, IOS_SIMULATOR, MACOS_DEVICE } from './__tests__/test-utils/device-fixtures.ts';
import { takeWarmRunnerLossNotice } from './platform-runtime-warm-runner-notice.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

test('an iOS Simulator reads the notice recorded for its id', async () => {
  mocks.takeRunnerWarmLossNotice.mockResolvedValueOnce(NOTICE);

  expect(await takeWarmRunnerLossNotice(IOS_SIMULATOR)).toEqual(NOTICE);
  expect(mocks.takeRunnerWarmLossNotice).toHaveBeenCalledWith(IOS_SIMULATOR.id);
});

test('a physical iOS device retains no warm runner and reads nothing', async () => {
  expect(await takeWarmRunnerLossNotice(IOS_DEVICE)).toBeUndefined();
  expect(mocks.takeRunnerWarmLossNotice).not.toHaveBeenCalled();
});

test('a macOS device retains no warm runner and reads nothing', async () => {
  expect(await takeWarmRunnerLossNotice(MACOS_DEVICE)).toBeUndefined();
  expect(mocks.takeRunnerWarmLossNotice).not.toHaveBeenCalled();
});
