import { afterEach, expect, test, vi } from 'vitest';
import type {
  LocalApplicationInteractorHost,
  OpenApplicationInput,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor, SnapshotOptions } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
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
    snapshot?: (options: SnapshotOptions | undefined) => Promise<unknown>;
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
        snapshot: async (options?: SnapshotOptions) => {
          calls.push(`snapshot:${options?.appBundleId}`);
          return await (params.snapshot?.(options) ?? Promise.resolve({ nodes: [] }));
        },
      }) as unknown as Interactor,
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

/** What the Android capture throws once its bounded re-capture still sees an unmounted app. */
function unreadableLaunchContentError(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Android snapshot helper returned insufficient foreground app content',
    {
      androidSnapshotHelperFailureReason: 'content-poor-app-window',
      attempts: 3,
      retriable: true,
    },
  );
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

test('an Android app open returns only after a capture of the launched app is readable', async () => {
  let releaseCapture: () => void = () => {};
  const captureReleased = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  const { calls, lifecycle } = createLifecycle({
    openedAppBundleId: 'com.example.opened',
    snapshot: async () => {
      await captureReleased;
      return { nodes: [] };
    },
  });

  let settled = false;
  const opening = lifecycle.openApplication(openInput()).then((outcome) => {
    settled = true;
    return outcome;
  });
  await vi.waitFor(() => expect(calls).toContain('snapshot:com.example.opened'));
  await Promise.resolve();
  expect(settled).toBe(false);
  releaseCapture();
  const outcome = await opening;

  expect(calls).toEqual(['open:com.example.app', 'snapshot:com.example.opened']);
  expect(outcome.appBundleId).toBe('com.example.opened');
  expect(outcome.timing.postOpenObservation).toBe('observable');
  expect(outcome.timing.postOpenSettleDurationMs).toEqual(expect.any(Number));
});

test('an app still unreadable after the capture re-captures opens as unobservable', async () => {
  const { calls, lifecycle } = createLifecycle({
    snapshot: async () => {
      throw unreadableLaunchContentError();
    },
  });

  const outcome = await lifecycle.openApplication(openInput({ relaunch: true }));

  expect(calls).toEqual(['open:com.example.app', 'snapshot:com.example.app']);
  expect(outcome.appBundleId).toBe('com.example.app');
  expect(outcome.timing.postOpenObservation).toBe('unobservable');
});

test('a cancelled open does not report the launch observation as unobservable', async () => {
  const controller = new AbortController();
  const { lifecycle } = createLifecycle({
    signal: controller.signal,
    snapshot: async () => {
      controller.abort(new Error('request cancelled'));
      throw unreadableLaunchContentError();
    },
  });

  await expect(lifecycle.openApplication(openInput())).rejects.toThrow('request cancelled');
});

test('an open whose launched app package is unknown does not observe the launch', async () => {
  const { calls, lifecycle } = createLifecycle({ openedAppBundleId: undefined });

  const outcome = await lifecycle.openApplication(
    openInput({ target: 'https://example.com', positionals: ['https://example.com'] }),
  );

  expect(calls).toEqual(['open:https://example.com']);
  expect(outcome.timing.postOpenObservation).toBe('not-eligible');
});
