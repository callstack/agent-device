import { expect, test, vi } from 'vitest';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';
import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';
import { resolveIosSimulatorDeepLinkBundleId } from './core/app-resolution.ts';
import { IOS_APP_LAUNCH_TIMEOUT_MS } from './core/config.ts';
import { type AppleToolProvider, withAppleToolProvider } from './core/tool-provider.ts';
import {
  answerLaunchConfirmation,
  answerSimulatorLaunchConfirmation,
  createLaunchConfirmationPort,
  LAUNCH_CONFIRMATION_FOREIGN_APP_REASON,
  type LaunchConfirmationPort,
  URL_OWNER_LOOKUP_TIMEOUT_MS,
} from './launch-confirmation.ts';
import { alertNotFound, CONFIRMATION } from './launch-confirmation.fixtures.ts';

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn() };
});

vi.mock('./core/app-resolution.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/app-resolution.ts')>();
  return {
    ...actual,
    resolveIosSimulatorDeepLinkBundleId: vi.fn(actual.resolveIosSimulatorDeepLinkBundleId),
  };
});

const simulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-simulator',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

/** How `exec.ts` rejects a spawn that outlives its timeout; `allowFailure` does not absorb it. */
function spawnTimeout(): AppError {
  return new AppError('COMMAND_FAILED', 'xcrun timed out', { timeoutMs: 10_000 });
}

function port(
  readAlert: () => Promise<Record<string, unknown> | undefined>,
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

    await expect(answerLaunchConfirmation(device)).resolves.toEqual({ outcome: 'accepted' });
    expect(device.readAlert).toHaveBeenCalledOnce();
    expect(acceptAlert).toHaveBeenCalledOnce();
  },
);

test('a confirmation for a URL another app owns is never accepted, whatever name it shows', async () => {
  const { port: device, acceptAlert } = port(async () => CONFIRMATION, {
    resolveUrlOwner: async () => 'com.example.other',
  });

  const failure = await answerLaunchConfirmation(device).catch((error: unknown) => error);

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
  const { port: device, acceptAlert, resolveUrlOwner } = port(async () => undefined);

  await expect(answerLaunchConfirmation(device)).resolves.toEqual({ outcome: 'absent' });
  expect(device.readAlert).toHaveBeenCalledOnce();
  expect(resolveUrlOwner).not.toHaveBeenCalled();
  expect(acceptAlert).not.toHaveBeenCalled();
});

test('an alert that is not a launch confirmation is left for the caller and reported', async () => {
  const {
    port: device,
    acceptAlert,
    resolveUrlOwner,
  } = port(async () => ({
    message: 'Allow “Example App” to use your location?',
    items: ['Allow Once', 'Don’t Allow'],
  }));

  await expect(answerLaunchConfirmation(device)).resolves.toEqual({
    outcome: 'unanswered',
    reason: 'alert-unrecognized',
  });
  expect(resolveUrlOwner).not.toHaveBeenCalled();
  expect(acceptAlert).not.toHaveBeenCalled();
  expect(emitDiagnostic).toHaveBeenCalledWith({
    level: 'warn',
    phase: 'ios_launch_confirmation_unanswered',
    data: {
      reason: 'alert-unrecognized',
      title: 'Allow “Example App” to use your location?',
      buttons: ['Allow Once', 'Don’t Allow'],
    },
  });
});

test('a launch confirmation in another language is left on screen and reported', async () => {
  const { port: device, acceptAlert } = port(async () => ({
    message: 'In „Beispiel-App“ öffnen?',
    items: ['Abbrechen', 'Öffnen'],
  }));

  await expect(answerLaunchConfirmation(device)).resolves.toEqual({
    outcome: 'unanswered',
    reason: 'alert-unrecognized',
  });
  expect(acceptAlert).not.toHaveBeenCalled();
  expect(emitDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        reason: 'alert-unrecognized',
        title: 'In „Beispiel-App“ öffnen?',
      }),
    }),
  );
});

test('a URL no single installed app owns is neither accepted nor reported as foreign', async () => {
  const { port: device, acceptAlert } = port(async () => CONFIRMATION, {
    resolveUrlOwner: async () => undefined,
  });

  await expect(answerLaunchConfirmation(device)).resolves.toEqual({
    outcome: 'unanswered',
    reason: 'url-owner-unresolved',
  });
  expect(acceptAlert).not.toHaveBeenCalled();
});

test.each([
  [
    'the alert read fails',
    port(async () => {
      throw new AppError('COMMAND_FAILED', 'runner unavailable', { reason: 'runner-start-failed' });
    }),
    { outcome: 'unreadable', step: 'alert-read' },
  ],
  [
    'the URL owner lookup rejects',
    port(async () => CONFIRMATION, {
      resolveUrlOwner: async () => {
        throw spawnTimeout();
      },
    }),
    { outcome: 'unreadable', step: 'url-owner' },
  ],
  [
    'the accept rejects',
    port(async () => CONFIRMATION, {
      acceptAlert: async () => {
        throw spawnTimeout();
      },
    }),
    { outcome: 'unreadable', step: 'alert-accept' },
  ],
])('an answer attempt where %s reports %j', async (_case, { port: device }, expected) => {
  await expect(answerLaunchConfirmation(device)).resolves.toEqual(expected);
});

/**
 * A CoreSimulator that never answers: each spawn settles only when its exec timeout fires or its
 * signal aborts, the way `exec.ts` ends a wedged child. `answers` lets named spawns answer at once,
 * so the wedge can sit behind a listing that succeeded.
 */
function wedgedCoreSimulator(
  answers: Readonly<Record<string, string>> = {},
): AppleToolProvider & { spawns: () => number } {
  let spawns = 0;
  const answered = (key: string): ExecResult | undefined => {
    const stdout = answers[key];
    if (stdout === undefined) return undefined;
    spawns += 1;
    return { stdout, stderr: '', exitCode: 0 } as ExecResult;
  };
  const hang = async (options?: ExecOptions): Promise<ExecResult> =>
    await new Promise((_resolve, reject) => {
      spawns += 1;
      if (options?.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      const timer = options?.timeoutMs
        ? setTimeout(() => reject(spawnTimeout()), options.timeoutMs)
        : undefined;
      options?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(options.signal?.reason);
        },
        { once: true },
      );
    });
  return {
    whichCommand: async () => true,
    runCommand: async (cmd, args, options) =>
      answered(`${cmd} ${args.at(-1)}`) ?? (await hang(options)),
    simctl: { run: async (args, options) => answered(args[0] ?? '') ?? (await hang(options)) },
    devicectl: { run: async (_args, options) => await hang(options) },
    spawns: () => spawns,
  };
}

/** Real I/O turns until the provider saw `count` spawns; bounded so a lookup that stops early fails here, not at the test timeout. */
async function untilSpawned(coreSimulator: { spawns: () => number }, count: number): Promise<void> {
  for (let turn = 0; turn < 1000 && coreSimulator.spawns() < count; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(coreSimulator.spawns()).toBe(count);
}

const LISTED_APP = JSON.stringify({
  'com.example.app': {
    ApplicationType: 'User',
    Path: '/apps/Example.app',
    CFBundleName: 'Example',
  },
});

test.each([
  ['one Info.plist read hangs after the app list answered', { listapps: LISTED_APP }],
  [
    'the app list answered in a format only plutil can convert, and that conversion hangs',
    { listapps: '{ "com.example.app" = { ApplicationType = User; }; }' },
  ],
])(
  'the owner lookup is bounded as a whole: %s and the open is left unanswered within its budget',
  async (_case, answers) => {
    // Only the clock is faked: the lookup stats the Info.plist on the real file system before it
    // spawns plutil, and that I/O must complete before the budget is advanced past.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.mocked(emitDiagnostic).mockClear();
    try {
      const { interactor, acceptAlert } = confirmationRunner();
      const coreSimulator = wedgedCoreSimulator(answers);
      let answered: unknown = 'pending';
      const answer = withAppleToolProvider(coreSimulator, async () =>
        answerSimulatorLaunchConfirmation(
          simulator,
          { url: 'example://automation', appBundleId: 'com.example.app' },
          Promise.resolve(interactor),
          new AbortController().signal,
        ).then((value) => (answered = value)),
      );

      await untilSpawned(coreSimulator, 2);
      await vi.advanceTimersByTimeAsync(URL_OWNER_LOOKUP_TIMEOUT_MS + 1);
      expect(answered).toEqual({ outcome: 'unreadable', step: 'url-owner' });
      await answer;
      expect(acceptAlert).not.toHaveBeenCalled();
      expect(emitDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reason: 'step-failed', step: 'url-owner' }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  },
);

function confirmationRunner() {
  const acceptAlert = vi.fn(async () => ({}));
  const interactor = { readAlert: async () => CONFIRMATION, acceptAlert } as unknown as Interactor;
  return { interactor, acceptAlert };
}

test('a hung URL owner lookup leaves the open unanswered within the launch budget', async () => {
  vi.useFakeTimers();
  try {
    const { interactor, acceptAlert } = confirmationRunner();
    let answered: unknown = 'pending';
    const answer = withAppleToolProvider(wedgedCoreSimulator(), async () =>
      answerSimulatorLaunchConfirmation(
        simulator,
        { url: 'example://automation', appBundleId: 'com.example.app' },
        Promise.resolve(interactor),
        new AbortController().signal,
      ).then((value) => (answered = value)),
    );

    await vi.advanceTimersByTimeAsync(IOS_APP_LAUNCH_TIMEOUT_MS - 1);
    expect(answered).toEqual({ outcome: 'unreadable', step: 'url-owner' });
    await answer;
    expect(acceptAlert).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ['during the lookup', false],
  ['before the lookup starts', true],
])('the open aborting %s ends the URL owner lookup', async (_label, abortedBeforeLookup) => {
  const { interactor, acceptAlert } = confirmationRunner();
  const open = new AbortController();
  const canceled = new AppError('COMMAND_FAILED', 'request canceled');
  if (abortedBeforeLookup) open.abort(canceled);
  const coreSimulator = wedgedCoreSimulator();
  const answer = withAppleToolProvider(coreSimulator, async () =>
    answerSimulatorLaunchConfirmation(
      simulator,
      { url: 'example://automation', appBundleId: 'com.example.app' },
      Promise.resolve(interactor),
      open.signal,
    ),
  );

  await vi.waitFor(() => expect(coreSimulator.spawns()).toBe(1));
  if (!abortedBeforeLookup) open.abort(canceled);

  await expect(answer).resolves.toEqual({ outcome: 'unreadable', step: 'url-owner' });
  expect(acceptAlert).not.toHaveBeenCalled();
});

test('the port reads and accepts the alert for the session app and asks the scheme owner', async () => {
  const readAlert = vi.fn(async () => CONFIRMATION);
  const acceptAlert = vi.fn(async () => ({}));
  const interactor = { readAlert, acceptAlert } as unknown as Interactor;

  const signal = new AbortController().signal;
  vi.mocked(resolveIosSimulatorDeepLinkBundleId).mockResolvedValueOnce('com.example.app');

  const device = createLaunchConfirmationPort(
    simulator,
    { url: 'example://automation', appBundleId: 'com.example.app' },
    interactor,
    signal,
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
    { timeoutMs: expect.any(Number), signal },
  );
});

test('the port reads a typed absence as no alert and keeps any other failure', async () => {
  const runnerDown = new AppError('COMMAND_FAILED', 'runner unavailable', {
    reason: 'runner-start-failed',
  });
  const readAlert = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockRejectedValueOnce(alertNotFound())
    .mockRejectedValueOnce(runnerDown);
  const interactor = { readAlert, acceptAlert: vi.fn() } as unknown as Interactor;

  const device = createLaunchConfirmationPort(
    simulator,
    { url: 'example://automation', appBundleId: 'com.example.app' },
    interactor,
    new AbortController().signal,
  );

  await expect(device.readAlert()).resolves.toBeUndefined();
  await expect(device.readAlert()).rejects.toBe(runnerDown);
});

test('a runner that cannot be resolved reports an unreadable attempt', async () => {
  await expect(
    answerSimulatorLaunchConfirmation(
      simulator,
      { url: 'example://automation', appBundleId: 'com.example.app' },
      Promise.reject(new AppError('COMMAND_FAILED', 'xcrun timed out', { timeoutMs: 10_000 })),
      new AbortController().signal,
    ),
  ).resolves.toEqual({ outcome: 'unreadable', step: 'runner' });
});
