import { expect, test, vi } from 'vitest';
import { ALERT_NOT_FOUND_RUNNER_CODE } from '@agent-device/contracts/alert-contract';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  answerLaunchConfirmation,
  createLaunchConfirmationPort,
  LAUNCH_CONFIRMATION_FOREIGN_APP_REASON,
  type LaunchConfirmationPort,
} from './launch-confirmation.ts';

vi.mock('./core/app-resolution.ts', () => ({
  listIosApps: vi.fn(async () => [
    { bundleId: 'com.example.other', name: 'Other App' },
    { bundleId: 'com.example.app', name: 'Example App' },
  ]),
}));

const simulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-simulator',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

/** The runner's typed absence: `alert get` looked once and found no alert. */
function alertNotFound(): AppError {
  return new AppError('COMMAND_FAILED', 'alert not found', {
    runnerErrorCode: ALERT_NOT_FOUND_RUNNER_CODE,
  });
}

function port(readAlert: () => Promise<Record<string, unknown>>) {
  const acceptAlert = vi.fn(async () => ({}));
  const readSessionAppName = vi.fn(async () => 'Example App');
  const value: LaunchConfirmationPort = {
    appBundleId: 'com.example.app',
    readAlert: vi.fn(readAlert),
    acceptAlert,
    readSessionAppName,
  };
  return { port: value, acceptAlert, readSessionAppName };
}

test.each([
  ['curly', 'Open in “Example App”?'],
  ['straight', 'Open in "Example App"?'],
])('accepts a confirmation that names the session app with %s quotes', async (_quotes, message) => {
  const { port: device, acceptAlert } = port(async () => ({
    message,
    items: ['Cancel', 'Open'],
  }));

  await expect(answerLaunchConfirmation(device)).resolves.toBe('accepted');
  expect(device.readAlert).toHaveBeenCalledOnce();
  expect(acceptAlert).toHaveBeenCalledOnce();
});

test('a confirmation naming another app is never accepted and fails with the app name', async () => {
  const { port: device, acceptAlert } = port(async () => ({
    message: 'Open in “Other App”?',
    items: ['Cancel', 'Open'],
  }));

  const failure = await answerLaunchConfirmation(device).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(AppError);
  expect((failure as AppError).code).toBe('COMMAND_FAILED');
  expect((failure as AppError).details).toMatchObject({
    reason: LAUNCH_CONFIRMATION_FOREIGN_APP_REASON,
    appName: 'Other App',
    appBundleId: 'com.example.app',
    sessionAppName: 'Example App',
  });
  expect(acceptAlert).not.toHaveBeenCalled();
});

test('no alert costs one read and answers nothing', async () => {
  const {
    port: device,
    acceptAlert,
    readSessionAppName,
  } = port(async () => {
    throw alertNotFound();
  });

  await expect(answerLaunchConfirmation(device)).resolves.toBeUndefined();
  expect(device.readAlert).toHaveBeenCalledOnce();
  expect(readSessionAppName).not.toHaveBeenCalled();
  expect(acceptAlert).not.toHaveBeenCalled();
});

test('an alert that is not a launch confirmation is left for the caller', async () => {
  const {
    port: device,
    acceptAlert,
    readSessionAppName,
  } = port(async () => ({
    message: 'Allow “Example App” to use your location?',
    items: ['Allow Once', 'Don’t Allow'],
  }));

  await expect(answerLaunchConfirmation(device)).resolves.toBeUndefined();
  expect(readSessionAppName).not.toHaveBeenCalled();
  expect(acceptAlert).not.toHaveBeenCalled();
});

test('a failed alert read is reported as itself, not as an absent confirmation', async () => {
  const runnerDown = new AppError('COMMAND_FAILED', 'runner unavailable', {
    reason: 'runner-start-failed',
  });
  const { port: device } = port(async () => {
    throw runnerDown;
  });

  await expect(answerLaunchConfirmation(device)).rejects.toBe(runnerDown);
});

test('the port reads and accepts the alert for the session app and names it from the app list', async () => {
  const readAlert = vi.fn(async () => ({ message: 'Open in “Example App”?' }));
  const acceptAlert = vi.fn(async () => ({}));
  const interactor = { readAlert, acceptAlert } as unknown as Interactor;

  const device = createLaunchConfirmationPort(simulator, 'com.example.app', interactor);
  await device.readAlert();
  await device.acceptAlert();

  const target = { appBundleId: 'com.example.app', surface: 'app' };
  expect(readAlert).toHaveBeenCalledWith(target);
  expect(acceptAlert).toHaveBeenCalledWith(target);
  await expect(device.readSessionAppName()).resolves.toBe('Example App');
});
