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

const BUDGET_MS = 60_000;

const INSTALLED_APPS = [
  { bundleId: 'com.example.other', name: 'Other App' },
  { bundleId: 'com.example.app', name: 'Example App' },
];

function port(
  readAlert: () => Promise<Record<string, unknown>>,
  installedApps: readonly { bundleId: string; name: string }[] = INSTALLED_APPS,
) {
  const acceptAlert = vi.fn(async () => ({}));
  const listInstalledApps = vi.fn(async () => installedApps);
  const value: LaunchConfirmationPort = {
    appBundleId: 'com.example.app',
    readAlert: vi.fn(readAlert),
    acceptAlert,
    listInstalledApps,
  };
  return { port: value, acceptAlert, listInstalledApps };
}

test.each([
  ['curly', 'Open in “Example App”?'],
  ['straight', 'Open in "Example App"?'],
])('accepts a confirmation that names the session app with %s quotes', async (_quotes, message) => {
  const { port: device, acceptAlert } = port(async () => ({
    message,
    items: ['Cancel', 'Open'],
  }));

  await expect(answerLaunchConfirmation(device, BUDGET_MS)).resolves.toBe('accepted');
  expect(device.readAlert).toHaveBeenCalledOnce();
  expect(acceptAlert).toHaveBeenCalledOnce();
});

test('a confirmation naming another installed app is never accepted and fails naming both apps', async () => {
  const { port: device, acceptAlert } = port(async () => ({
    message: 'Open in “Other App”?',
    items: ['Cancel', 'Open'],
  }));

  const failure = await answerLaunchConfirmation(device, BUDGET_MS).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(AppError);
  expect((failure as AppError).code).toBe('COMMAND_FAILED');
  expect((failure as AppError).details).toMatchObject({
    reason: LAUNCH_CONFIRMATION_FOREIGN_APP_REASON,
    appName: 'Other App',
    foreignAppBundleId: 'com.example.other',
    sessionAppBundleId: 'com.example.app',
  });
  expect(acceptAlert).not.toHaveBeenCalled();
});

test('no alert costs one read and answers nothing', async () => {
  const {
    port: device,
    acceptAlert,
    listInstalledApps,
  } = port(async () => {
    throw alertNotFound();
  });

  await expect(answerLaunchConfirmation(device, BUDGET_MS)).resolves.toBeUndefined();
  expect(device.readAlert).toHaveBeenCalledOnce();
  expect(listInstalledApps).not.toHaveBeenCalled();
  expect(acceptAlert).not.toHaveBeenCalled();
});

test('an alert that is not a launch confirmation is left for the caller', async () => {
  const {
    port: device,
    acceptAlert,
    listInstalledApps,
  } = port(async () => ({
    message: 'Allow “Example App” to use your location?',
    items: ['Allow Once', 'Don’t Allow'],
  }));

  await expect(answerLaunchConfirmation(device, BUDGET_MS)).resolves.toBeUndefined();
  expect(listInstalledApps).not.toHaveBeenCalled();
  expect(acceptAlert).not.toHaveBeenCalled();
});

test.each([
  ['nothing installed carries', [{ bundleId: 'com.example.other', name: 'Other App' }]],
  [
    'two installed bundles share',
    [
      { bundleId: 'com.example.app', name: 'Example App' },
      { bundleId: 'com.example.app.dev', name: 'Example App' },
    ],
  ],
])(
  'a confirmation naming an app %s is neither accepted nor reported as foreign',
  async (_case, installedApps) => {
    const { port: device, acceptAlert } = port(
      async () => ({ message: 'Open in “Example App”?', items: ['Cancel', 'Open'] }),
      installedApps,
    );

    await expect(answerLaunchConfirmation(device, BUDGET_MS)).resolves.toBeUndefined();
    expect(acceptAlert).not.toHaveBeenCalled();
  },
);

test('a failed alert read leaves the open unanswered', async () => {
  const { port: device, acceptAlert } = port(async () => {
    throw new AppError('COMMAND_FAILED', 'runner unavailable', { reason: 'runner-start-failed' });
  });

  await expect(answerLaunchConfirmation(device, BUDGET_MS)).resolves.toBeUndefined();
  expect(acceptAlert).not.toHaveBeenCalled();
});

test('an alert read that outlives the launch budget leaves the open unanswered', async () => {
  vi.useFakeTimers();
  try {
    const { port: device, acceptAlert } = port(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ message: 'Open in “Example App”?' }), BUDGET_MS * 2);
        }),
    );

    const answer = answerLaunchConfirmation(device, BUDGET_MS);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);

    await expect(answer).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(acceptAlert).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('the port reads and accepts the alert for the session app and lists every installed app', async () => {
  const readAlert = vi.fn(async () => ({ message: 'Open in “Example App”?' }));
  const acceptAlert = vi.fn(async () => ({}));
  const interactor = { readAlert, acceptAlert } as unknown as Interactor;

  const device = createLaunchConfirmationPort(simulator, 'com.example.app', interactor);
  await device.readAlert();
  await device.acceptAlert();

  const target = { appBundleId: 'com.example.app', surface: 'app' };
  expect(readAlert).toHaveBeenCalledWith(target);
  expect(acceptAlert).toHaveBeenCalledWith(target);
  await expect(device.listInstalledApps()).resolves.toEqual([
    { bundleId: 'com.example.other', name: 'Other App' },
    { bundleId: 'com.example.app', name: 'Example App' },
  ]);
});
