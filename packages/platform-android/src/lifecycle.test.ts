import { afterEach, expect, test, vi } from 'vitest';
import type {
  LocalApplicationInteractorHost,
  OpenApplicationInput,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import type {
  AndroidLaunchObservation,
  AndroidLaunchObservationPort,
} from './launch-observation.ts';
import { bindAndroidApplicationLifecycle } from './lifecycle.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

type LifecycleFixture = Readonly<{
  calls: string[];
  lifecycle: ReturnType<typeof bindAndroidApplicationLifecycle>;
}>;

function createLifecycle(
  params: Readonly<{
    observe?: (appBundleId: string, signal: AbortSignal) => Promise<AndroidLaunchObservation>;
    openedAppBundleId?: string;
    signal?: AbortSignal;
  }> = {},
): LifecycleFixture {
  const calls: string[] = [];
  const localInteractors: LocalApplicationInteractorHost = {
    resolve: async () =>
      ({
        open: async (app: string) => {
          calls.push(`open:${app}`);
        },
        openDevice: async () => {},
        close: async () => {},
        setSetting: async () => {},
      }) as unknown as Interactor,
  };
  const launchObservation: AndroidLaunchObservationPort = {
    awaitObservable: async (_interactor, appBundleId, signal) => {
      calls.push(`observe:${appBundleId}`);
      return await (params.observe?.(appBundleId, signal) ??
        Promise.resolve({ observation: 'observable' as const }));
    },
  };
  const host = {
    localInteractors,
    deviceReadiness: {
      android: { ensureReady: async () => ({ ...device, booted: true }) },
    },
    deviceShutdown: {
      android: { shutdownTarget: async () => undefined },
    },
    androidApplications: {
      resolveOpenTarget: async () => ({}),
      inferOpenedAppBundleId: async () =>
        'openedAppBundleId' in params ? params.openedAppBundleId : 'com.example.app',
      resetFramePerfStats: async () => {},
      applyRuntimeHints: async () => {},
      clearRuntimeHints: async () => {},
      activateTestIme: async () => {},
      restoreTestIme: async () => {},
      recoverTestImeStartup: async () => {},
      hasTestImeRecoveryEvidence: async () => false,
    },
  } as unknown as Pick<
    PlatformRuntimeHost,
    | 'androidApplications'
    | 'clock'
    | 'commands'
    | 'deviceReadiness'
    | 'deviceShutdown'
    | 'localInteractors'
    | 'toolchains'
  >;
  const lifecycle = bindAndroidApplicationLifecycle({
    host,
    device,
    signal: params.signal ?? new AbortController().signal,
    launchObservation,
  });
  return { calls, lifecycle };
}

function openInput(overrides: Partial<OpenApplicationInput> = {}): OpenApplicationInput {
  return {
    target: 'com.example.app',
    positionals: ['com.example.app'],
    appBundleId: 'com.example.app',
    surface: 'app',
    hasExistingSession: false,
    relaunch: false,
    prewarmRunnerBeforeOpen: false,
    enableTestIme: false,
    stateDir: '/state',
    runtimeHints: {},
    execution: {},
    ...overrides,
  };
}

test('preserves a runtime launch URL duration after the admitted Android follow-up open', async () => {
  const { calls, lifecycle } = createLifecycle();
  vi.spyOn(Date, 'now')
    .mockReturnValueOnce(10)
    .mockReturnValueOnce(20)
    .mockReturnValueOnce(30)
    .mockReturnValueOnce(50);

  const outcome = await lifecycle.openApplication(
    openInput({ runtimeLaunchUrl: 'example://after-open' }),
  );

  expect(calls.filter((call) => call.startsWith('open:'))).toEqual([
    'open:com.example.app',
    'open:example://after-open',
  ]);
  expect(outcome.timing.launchUrlDurationMs).toBe(20);
});

test('an Android app open returns only after the launched app observation settles', async () => {
  let settleObservation: (observation: AndroidLaunchObservation) => void = () => {};
  const { calls, lifecycle } = createLifecycle({
    openedAppBundleId: 'com.example.opened',
    observe: async () =>
      await new Promise<AndroidLaunchObservation>((resolve) => {
        settleObservation = resolve;
      }),
  });

  let settled = false;
  const opening = lifecycle.openApplication(openInput()).then((outcome) => {
    settled = true;
    return outcome;
  });
  await vi.waitFor(() => expect(calls).toContain('observe:com.example.opened'));
  await Promise.resolve();
  expect(settled).toBe(false);
  settleObservation({ observation: 'unobservable' });
  const outcome = await opening;

  expect(calls).toEqual(['open:com.example.app', 'observe:com.example.opened']);
  expect(outcome.appBundleId).toBe('com.example.opened');
  expect(outcome.timing.postOpenObservation).toBe('unobservable');
  expect(outcome.timing.postOpenObservationFailure).toBeUndefined();
  expect(outcome.timing.postOpenSettleDurationMs).toEqual(expect.any(Number));
});

test('a failed launch probe reports its typed failure and the open still succeeds', async () => {
  const { lifecycle } = createLifecycle({
    observe: async () => ({
      observation: 'probe-failed',
      failure: { code: 'COMMAND_FAILED', reason: 'accessibility-timeout' },
    }),
  });

  const outcome = await lifecycle.openApplication(openInput({ relaunch: true }));

  expect(outcome.timing.postOpenObservation).toBe('probe-failed');
  expect(outcome.timing.postOpenObservationFailure).toEqual({
    code: 'COMMAND_FAILED',
    reason: 'accessibility-timeout',
  });
});

test('a cancelled open rejects with the cancellation the observation raised', async () => {
  const controller = new AbortController();
  const canceled = createRequestCanceledError();
  const { lifecycle } = createLifecycle({
    signal: controller.signal,
    observe: async (_appBundleId, signal) => {
      expect(signal).toBe(controller.signal);
      throw canceled;
    },
  });

  await expect(lifecycle.openApplication(openInput())).rejects.toBe(canceled);
});

test('a URL open has no launched app to observe and leaves the observation unset', async () => {
  const { calls, lifecycle } = createLifecycle({ openedAppBundleId: 'com.example.browser' });

  const outcome = await lifecycle.openApplication(
    openInput({
      target: 'https://example.com',
      positionals: ['https://example.com'],
      appBundleId: undefined,
    }),
  );

  expect(calls).toEqual(['open:https://example.com']);
  expect(outcome.timing.postOpenObservation).toBeUndefined();
});

test('an app open whose launched package cannot be identified reports it unidentified', async () => {
  const { calls, lifecycle } = createLifecycle({ openedAppBundleId: undefined });

  const outcome = await lifecycle.openApplication(
    openInput({ target: 'Example', positionals: ['Example'], appBundleId: undefined }),
  );

  expect(calls).toEqual(['open:Example']);
  expect(outcome.timing.postOpenObservation).toBe('app-unidentified');
});
