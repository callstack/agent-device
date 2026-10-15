import { beforeEach, expect, test, vi } from 'vitest';
import { IOS_SIMULATOR, ANDROID_EMULATOR } from '@agent-device/test-kit/device-fixtures';
import { platformResourceCleanup } from './platform-runtime-resource-cleanup.ts';

const { RUNNER_BUNDLE_ID, closeIosApp, stopIosRunnerSession } = vi.hoisted(() => ({
  RUNNER_BUNDLE_ID: 'com.example.test-runner',
  closeIosApp: vi.fn(async () => {}),
  stopIosRunnerSession: vi.fn(async () => {}),
}));

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>()),
  stopIosRunnerSession,
  resolveRunnerAppBundleId: () => RUNNER_BUNDLE_ID,
}));
vi.mock('@agent-device/platform-apple/app-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/app-lifecycle')>()),
  closeIosApp,
}));

beforeEach(() => {
  closeIosApp.mockReset().mockResolvedValue();
  stopIosRunnerSession.mockReset().mockResolvedValue();
});

test('sessionless iOS runner cleanup stops the runner host app', async () => {
  await platformResourceCleanup.cleanupSessionlessExecutionHost(IOS_SIMULATOR);

  expect(stopIosRunnerSession).toHaveBeenCalledWith(IOS_SIMULATOR.id);
  expect(closeIosApp).toHaveBeenCalledWith(IOS_SIMULATOR, RUNNER_BUNDLE_ID);
  expect(stopIosRunnerSession.mock.invocationCallOrder[0]!).toBeLessThan(
    closeIosApp.mock.invocationCallOrder[0]!,
  );
});

test('sessionless iOS runner host close is best effort', async () => {
  closeIosApp.mockRejectedValueOnce(new Error('terminate failed'));

  await expect(
    platformResourceCleanup.cleanupSessionlessExecutionHost(IOS_SIMULATOR),
  ).resolves.toBeUndefined();

  expect(stopIosRunnerSession).toHaveBeenCalledWith(IOS_SIMULATOR.id);
  expect(closeIosApp).toHaveBeenCalledWith(IOS_SIMULATOR, RUNNER_BUNDLE_ID);
});

test('sessionless cleanup touches no runner host for a non-Apple device', async () => {
  await platformResourceCleanup.cleanupSessionlessExecutionHost(ANDROID_EMULATOR);

  expect(stopIosRunnerSession).not.toHaveBeenCalled();
  expect(closeIosApp).not.toHaveBeenCalled();
});
