import { expect, test, vi } from 'vitest';
import { ALERT_NOT_FOUND_RUNNER_CODE } from '@agent-device/contracts/alert-contract';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { resolveIosSimulatorDeepLinkBundleId } from './core/app-resolution.ts';
import {
  answerLaunchConfirmation,
  createLaunchConfirmationPort,
  LAUNCH_CONFIRMATION_FOREIGN_APP_REASON,
  type LaunchConfirmationPort,
} from './launch-confirmation.ts';

vi.mock('./core/app-resolution.ts', () => ({
  resolveIosSimulatorDeepLinkBundleId: vi.fn(async () => 'com.example.app'),
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

/** How `exec.ts` rejects a spawn that outlives its timeout; `allowFailure` does not absorb it. */
function spawnTimeout(): AppError {
  return new AppError('COMMAND_FAILED', 'xcrun timed out', { timeoutMs: 10_000 });
}

const BUDGET_MS = 60_000;
const CONFIRMATION = { message: 'Open in “Example App”?', items: ['Cancel', 'Open'] };

function port(
  readAlert: () => Promise<Record<string, unknown>>,
  legs: Readonly<{
    resolveUrlOwner?: () => Promise<string | undefined>;
    acceptAlert?: () => Promise<unknown>;
  }> = {},
) {
  const acceptAlert = vi.fn(legs.acceptAlert ?? (async () => ({})));
  const resolveUrlOwner = vi.fn(legs.resolveUrlOwner ?? (async () => 'com.example.app'));
  const value: LaunchConfirmationPort = {
    appBundleId: 'com.example.app',
    readAlert: vi.fn(readAlert),
    acceptAlert,
    resolveUrlOwner,
  };
  return { port: value, acceptAlert, resolveUrlOwner };
}

test.each([
  ['curly', 'Open in “Example App”?'],
  ['straight', 'Open in "Example App"?'],
  ['localized-name', 'Open in “Beispiel-App”?'],
])(
  'accepts a confirmation (%s title) when the URL owner is the session app',
  async (_case, message) => {
    const { port: device, acceptAlert } = port(async () => ({
      message,
      items: ['Cancel', 'Open'],
    }));

    await expect(answerLaunchConfirmation(device, BUDGET_MS)).resolves.toBe('accepted');
    expect(device.readAlert).toHaveBeenCalledOnce();
    expect(acceptAlert).toHaveBeenCalledOnce();
  },
);

test('a confirmation for a URL another app owns is never accepted, whatever name it shows', async () => {
  const { port: device, acceptAlert } = port(async () => CONFIRMATION, {
    resolveUrlOwner: async () => 'com.example.other',
  });

  const failure = await answerLaunchConfirmation(device, BUDGET_MS).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(AppError);
  expect((failure as AppError).code).toBe('COMMAND_FAILED');
  expect((failure as AppError).details).toMatchObject({
    reason: LAUNCH_CONFIRMATION_FOREIGN_APP_REASON,
    foreignAppBundleId: 'com.example.other',
    sessionAppBundleId: 'com.example.app',
  });
  expect(acceptAlert).not.toHaveBeenCalled();
});

test('no alert costs one read and answers nothing', async () => {
  const {
    port: device,
    acceptAlert,
    resolveUrlOwner,
  } = port(async () => {
    throw alertNotFound();
  });

  await expect(answerLaunchConfirmation(device, BUDGET_MS)).resolves.toBeUndefined();
  expect(device.readAlert).toHaveBeenCalledOnce();
  expect(resolveUrlOwner).not.toHaveBeenCalled();
  expect(acceptAlert).not.toHaveBeenCalled();
});

test('an alert that is not a launch confirmation is left for the caller', async () => {
  const {
    port: device,
    acceptAlert,
    resolveUrlOwner,
  } = port(async () => ({
    message: 'Allow “Example App” to use your location?',
    items: ['Allow Once', 'Don’t Allow'],
  }));

  await expect(answerLaunchConfirmation(device, BUDGET_MS)).resolves.toBeUndefined();
  expect(resolveUrlOwner).not.toHaveBeenCalled();
  expect(acceptAlert).not.toHaveBeenCalled();
});

test('a URL no single installed app owns is neither accepted nor reported as foreign', async () => {
  const { port: device, acceptAlert } = port(async () => CONFIRMATION, {
    resolveUrlOwner: async () => undefined,
  });

  await expect(answerLaunchConfirmation(device, BUDGET_MS)).resolves.toBeUndefined();
  expect(acceptAlert).not.toHaveBeenCalled();
});

test.each([
  [
    'the alert read fails',
    port(async () => {
      throw new AppError('COMMAND_FAILED', 'runner unavailable', { reason: 'runner-start-failed' });
    }),
  ],
  [
    'the URL owner lookup rejects',
    port(async () => CONFIRMATION, {
      resolveUrlOwner: async () => {
        throw spawnTimeout();
      },
    }),
  ],
  [
    'the accept rejects',
    port(async () => CONFIRMATION, {
      acceptAlert: async () => {
        throw spawnTimeout();
      },
    }),
  ],
])('the open is left unanswered when %s', async (_case, { port: device }) => {
  await expect(answerLaunchConfirmation(device, BUDGET_MS)).resolves.toBeUndefined();
});

test.each([
  ['the alert read', { read: BUDGET_MS * 2, owner: 0, accept: 0 }],
  ['the URL owner lookup', { read: BUDGET_MS / 2, owner: BUDGET_MS * 0.75, accept: 0 }],
  ['the accept', { read: BUDGET_MS / 3, owner: BUDGET_MS / 3, accept: BUDGET_MS / 2 }],
])('%s spending the rest of one shared budget leaves the open unanswered', async (_leg, delays) => {
  vi.useFakeTimers();
  try {
    const after = <T>(ms: number, value: T) =>
      new Promise<T>((resolve) => {
        setTimeout(() => resolve(value), ms);
      });
    const { port: device } = port(async () => await after(delays.read, CONFIRMATION), {
      resolveUrlOwner: async () => await after(delays.owner, 'com.example.app'),
      acceptAlert: async () => await after(delays.accept, {}),
    });

    const answer = answerLaunchConfirmation(device, BUDGET_MS);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);

    await expect(answer).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test('the port reads and accepts the alert for the session app and asks the scheme owner', async () => {
  const readAlert = vi.fn(async () => CONFIRMATION);
  const acceptAlert = vi.fn(async () => ({}));
  const interactor = { readAlert, acceptAlert } as unknown as Interactor;

  const device = createLaunchConfirmationPort(
    simulator,
    'com.example.app',
    'example://automation',
    async () => interactor,
  );
  await device.readAlert();
  await device.acceptAlert();

  const target = { appBundleId: 'com.example.app', surface: 'app' };
  expect(readAlert).toHaveBeenCalledWith(target);
  expect(acceptAlert).toHaveBeenCalledWith(target);
  await expect(device.resolveUrlOwner()).resolves.toBe('com.example.app');
  expect(resolveIosSimulatorDeepLinkBundleId).toHaveBeenCalledWith(
    simulator,
    'example://automation',
  );
});
