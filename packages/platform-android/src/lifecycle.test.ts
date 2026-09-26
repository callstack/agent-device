import { afterEach, expect, test, vi } from 'vitest';
import type {
  CloseApplicationInput,
  LocalApplicationInteractorHost,
  OpenApplicationInput,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor, SnapshotOptions } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { bindAndroidApplicationLifecycle } from './lifecycle.ts';
import { killAndroidApp } from './app-lifecycle.ts';

vi.mock('./app-lifecycle.ts', () => ({
  killAndroidApp: vi.fn(async () => {}),
}));

const mockKillAndroidApp = vi.mocked(killAndroidApp);

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
  mockKillAndroidApp.mockClear();
});

type LifecycleFixture = Readonly<{
  calls: string[];
  lifecycle: ReturnType<typeof bindAndroidApplicationLifecycle>;
}>;

function createLifecycle(
  params: Readonly<{
    snapshot?: (options: SnapshotOptions) => Promise<unknown>;
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
        snapshot: async (options: SnapshotOptions) => {
          calls.push(`observe:${options.appBundleId}`);
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
  let finishCapture: () => void = () => {};
  const { calls, lifecycle } = createLifecycle({
    openedAppBundleId: 'com.example.opened',
    snapshot: async () => {
      await new Promise<void>((resolve) => {
        finishCapture = resolve;
      });
      return { nodes: [], androidSnapshot: { backend: 'android-helper', systemSurfaceOnly: true } };
    },
  });

  let settled = false;
  const opening = lifecycle.openApplication(openInput()).then((outcome) => {
    settled = true;
    return outcome;
  });
  await vi.waitFor(() => expect(calls).toContain('observe:com.example.opened'));
  await Promise.resolve();
  expect(settled).toBe(false);
  finishCapture();
  const outcome = await opening;

  expect(calls).toEqual(['open:com.example.app', 'observe:com.example.opened']);
  expect(outcome.appBundleId).toBe('com.example.opened');
  expect(outcome.timing.postOpenObservation).toBe('unobservable');
  expect(outcome.timing.postOpenObservationFailure).toBeUndefined();
  expect(outcome.timing.postOpenSettleDurationMs).toEqual(expect.any(Number));
});

test('a failed launch probe reports its typed failure and the open still succeeds', async () => {
  const { lifecycle } = createLifecycle({
    snapshot: async () => {
      throw new AppError('COMMAND_FAILED', 'Android snapshot helper failed', {
        androidCaptureFailureReason: 'accessibility-timeout',
      });
    },
  });

  const outcome = await lifecycle.openApplication(openInput({ relaunch: true }));

  expect(outcome.timing.postOpenObservation).toBe('probe-failed');
  expect(outcome.timing.postOpenObservationFailure).toEqual({
    code: 'COMMAND_FAILED',
    reason: 'accessibility-timeout',
  });
});

test('a cancelled open rejects with its cancellation', async () => {
  const controller = new AbortController();
  const canceled = createRequestCanceledError();
  const { lifecycle } = createLifecycle({
    signal: controller.signal,
    snapshot: async (options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort(canceled);
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

function closeLifecycleHost(resolve: LocalApplicationInteractorHost['resolve']) {
  return {
    localInteractors: { resolve },
    deviceReadiness: {
      android: { ensureReady: async () => ({ ...device, booted: true }) },
    },
    deviceShutdown: {
      android: { shutdownTarget: async () => undefined },
    },
    androidApplications: {
      resolveOpenTarget: async () => ({}),
      inferOpenedAppBundleId: async () => 'com.example.app',
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
}

function closeInput(overrides: Partial<CloseApplicationInput> = {}): CloseApplicationInput {
  return {
    positionals: ['com.example.app'],
    appBundleId: 'com.example.app',
    surface: 'app',
    execution: {},
    ...overrides,
  };
}

test('kill mode calls killAndroidApp without resolving an interactor', async () => {
  let resolved = 0;
  const closed: string[] = [];
  const host = closeLifecycleHost(async () => {
    resolved += 1;
    return {
      open: async () => {},
      openDevice: async () => {},
      close: async (app: string) => {
        closed.push(app);
      },
      setSetting: async () => {},
    } as unknown as Interactor;
  });
  const lifecycle = bindAndroidApplicationLifecycle({
    host,
    device,
    signal: new AbortController().signal,
  });

  await lifecycle.closeApplication(closeInput({ mode: 'kill' }));

  expect(resolved).toBe(0);
  expect(closed).toEqual([]);
  expect(mockKillAndroidApp).toHaveBeenCalledOnce();
  expect(mockKillAndroidApp).toHaveBeenCalledWith(device, 'com.example.app');
});

test('stop close resolves an interactor and closes', async () => {
  let resolved = 0;
  const closed: string[] = [];
  const host = closeLifecycleHost(async () => {
    resolved += 1;
    return {
      open: async () => {},
      openDevice: async () => {},
      close: async (app: string) => {
        closed.push(app);
      },
      setSetting: async () => {},
    } as unknown as Interactor;
  });
  const lifecycle = bindAndroidApplicationLifecycle({
    host,
    device,
    signal: new AbortController().signal,
  });

  await lifecycle.closeApplication(closeInput());

  expect(resolved).toBe(1);
  expect(closed).toEqual(['com.example.app']);
  expect(mockKillAndroidApp).not.toHaveBeenCalled();
});

test('kill mode falls back to the session app identity when no positional target exists', async () => {
  const host = closeLifecycleHost(async () => {
    throw new Error('kill must not resolve an interactor');
  });
  const lifecycle = bindAndroidApplicationLifecycle({
    host,
    device,
    signal: new AbortController().signal,
  });

  await lifecycle.closeApplication(closeInput({ mode: 'kill', positionals: [] }));

  expect(mockKillAndroidApp).toHaveBeenCalledOnce();
  expect(mockKillAndroidApp).toHaveBeenCalledWith(device, 'com.example.app');
});

test('kill mode without any target fails loud instead of reading as success', async () => {
  const host = closeLifecycleHost(async () => {
    throw new Error('kill must not resolve an interactor');
  });
  const lifecycle = bindAndroidApplicationLifecycle({
    host,
    device,
    signal: new AbortController().signal,
  });

  await expect(
    lifecycle.closeApplication(
      closeInput({ mode: 'kill', positionals: [], appBundleId: undefined }),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(mockKillAndroidApp).not.toHaveBeenCalled();
});
