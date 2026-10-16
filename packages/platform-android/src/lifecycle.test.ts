import { afterEach, expect, test, vi } from 'vitest';
import type {
  CloseApplicationFinalizationInput,
  CloseApplicationInput,
  LocalApplicationInteractorHost,
  OpenApplicationInput,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor, SnapshotOptions } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { bindAndroidApplicationLifecycle } from './lifecycle.ts';
import { closeAndroidApp, killAndroidApp } from './app-lifecycle.ts';
import { withAndroidAdbProvider } from './adb-executor.ts';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';

vi.mock('./app-lifecycle.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./app-lifecycle.ts')>()),
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockKillAndroidApp.mockClear();
});

type LifecycleFixture = Readonly<{
  calls: string[];
  framePerfResets: string[];
  launchReports: Array<string | undefined>;
  lifecycle: ReturnType<typeof bindAndroidApplicationLifecycle>;
}>;

function createLifecycle(
  params: Readonly<{
    device?: DeviceInfo;
    snapshot?: (options: SnapshotOptions) => Promise<unknown>;
    openedAppBundleId?: string;
    launchedAppBundleId?: string;
    signal?: AbortSignal;
    restoreTestIme?: (
      device: DeviceInfo,
      input: Readonly<{ stateDir: string; shutdownTarget: boolean; signal: AbortSignal }>,
    ) => Promise<void>;
    shutdownTarget?: () => Promise<unknown>;
    close?: Interactor['close'];
  }> = {},
): LifecycleFixture {
  const calls: string[] = [];
  const framePerfResets: string[] = [];
  const launchReports: Array<string | undefined> = [];
  const localInteractors: LocalApplicationInteractorHost = {
    resolve: async () =>
      ({
        open: async (app: string, options?: { terminateRunningApp?: boolean }) => {
          calls.push(`open:${app}${options?.terminateRunningApp ? ' (terminate running)' : ''}`);
          return {
            launchedAppBundleId: app.includes('://')
              ? 'com.example.follow-up'
              : params.launchedAppBundleId,
          };
        },
        openDevice: async () => {},
        close: async (app: string) => {
          calls.push(`close:${app}`);
          await params.close?.(app);
        },
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
      android: {
        shutdownTarget: async () => await (params.shutdownTarget?.() ?? Promise.resolve(undefined)),
      },
    },
    androidApplications: {
      resolveOpenTarget: async () => ({}),
      inferOpenedAppBundleId: async (
        _device: DeviceInfo,
        _target: string | undefined,
        _current: string | undefined,
        launchedAppBundleId: string | undefined,
      ) => {
        launchReports.push(launchedAppBundleId);
        return 'openedAppBundleId' in params ? params.openedAppBundleId : 'com.example.app';
      },
      resetFramePerfStats: async (_device: DeviceInfo, appBundleId: string) => {
        framePerfResets.push(appBundleId);
      },
      applyRuntimeHints: async () => {},
      clearRuntimeHints: async () => {},
      activateTestIme: async () => {
        calls.push('activate-test-ime');
      },
      restoreTestIme: params.restoreTestIme ?? (async () => {}),
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
    device: params.device ?? device,
    signal: params.signal ?? new AbortController().signal,
  });
  return { calls, framePerfResets, launchReports, lifecycle };
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

test('relaunch refuses to open or observe after the Android process close fence expires', async () => {
  vi.useFakeTimers();
  bindAndroidAdbHostStub({});
  const { calls, lifecycle } = createLifecycle({
    close: async (app) => await closeAndroidApp(device, app),
  });
  await withAndroidAdbProvider(
    {
      exec: async (args) => ({
        stdout:
          args[1] === 'pidof'
            ? '12345\n'
            : args[1] === 'dumpsys'
              ? 'mCurrentFocus=Window{43 u0 com.android.launcher/.Launcher}\n'
              : '',
        stderr: '',
        exitCode: 0,
      }),
    },
    { serial: device.id },
    async () => {
      const rejection = expect(
        lifecycle.openApplication(openInput({ relaunch: true })),
      ).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: {
          reason: 'android-app-close-timeout',
          phase: 'process',
          packageName: 'com.example.app',
        },
      });
      await Promise.all([rejection, vi.runAllTimersAsync()]);
    },
  );
  expect(calls).toEqual(['close:com.example.app']);
});

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

test('an Android open activates the test IME after the launch dispatch when requested', async () => {
  const { calls, lifecycle } = createLifecycle();

  await lifecycle.openApplication(openInput({ enableTestIme: true }));

  expect(calls.slice(0, 2)).toEqual(['open:com.example.app', 'activate-test-ime']);
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
    source: 'capture',
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

function finalizationInput(
  overrides: Partial<CloseApplicationFinalizationInput> = {},
): CloseApplicationFinalizationInput {
  return {
    appBundleId: 'com.example.app',
    surface: 'app',
    retainRunner: false,
    stateDir: '/state',
    ...overrides,
  };
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

test('an Android relaunch closes the requested package before opening it', async () => {
  const { calls, lifecycle } = createLifecycle({ openedAppBundleId: 'com.android.settings' });

  await lifecycle.openApplication(
    openInput({
      target: 'com.android.settings',
      positionals: ['com.android.settings'],
      appBundleId: 'com.android.settings',
      relaunch: true,
    }),
  );

  expect(calls.slice(0, 2)).toEqual(['close:com.android.settings', 'open:com.android.settings']);
});

test('an Android intent relaunch has the launch terminate its handler and records the resumed owner', async () => {
  const { calls, framePerfResets, lifecycle } = createLifecycle({
    openedAppBundleId: 'com.android.settings',
  });

  const outcome = await lifecycle.openApplication(
    openInput({
      target: 'settings',
      positionals: ['settings'],
      appBundleId: undefined,
      relaunch: true,
    }),
  );

  expect(calls).toEqual(['open:settings (terminate running)', 'observe:com.android.settings']);
  expect(framePerfResets).toEqual(['com.android.settings']);
  expect(outcome.appBundleId).toBe('com.android.settings');
});

test('the owner inference receives the package the primary launch reported', async () => {
  const { launchReports, lifecycle } = createLifecycle({
    launchedAppBundleId: 'com.android.settings',
  });

  await lifecycle.openApplication(
    openInput({
      target: 'settings',
      positionals: ['settings'],
      appBundleId: undefined,
      runtimeLaunchUrl: 'example://after-open',
    }),
  );

  expect(launchReports).toEqual(['com.android.settings']);
});

test('an Android intent relaunch that resumes no app closes nothing and stays unidentified', async () => {
  const { calls, lifecycle } = createLifecycle({ openedAppBundleId: undefined });

  const outcome = await lifecycle.openApplication(
    openInput({
      target: 'settings',
      positionals: ['settings'],
      appBundleId: undefined,
      relaunch: true,
    }),
  );

  expect(calls).toEqual(['open:settings (terminate running)']);
  expect(outcome.appBundleId).toBeUndefined();
  expect(outcome.timing.postOpenObservation).toBe('app-unidentified');
});

test('close --shutdown restores the keyboard and only then kills the emulator (#3318)', async () => {
  const sequence: string[] = [];
  let finishRestore: () => void = () => {};
  const { lifecycle } = createLifecycle({
    restoreTestIme: async (_device, input) => {
      sequence.push(`restore:${input.shutdownTarget}`);
      await new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      sequence.push('restored');
    },
    shutdownTarget: async () => {
      sequence.push('shutdown');
      return { success: true, exitCode: 0, stdout: '', stderr: '' };
    },
  });

  let settled = false;
  const finalizing = lifecycle
    .finalizeApplicationClose(finalizationInput({ shutdownTarget: true }))
    .then((result) => {
      settled = true;
      return result ?? {};
    });
  await vi.waitFor(() => expect(sequence).toEqual(['restore:true']));
  await Promise.resolve();
  // The kill must wait on the awaited restore, which absorbs the settings-provider flush window.
  expect(settled).toBe(false);
  expect(sequence).toEqual(['restore:true']);
  finishRestore();

  const result = await finalizing;
  expect(sequence).toEqual(['restore:true', 'restored', 'shutdown']);
  expect(result.shutdown).toMatchObject({ success: true });
});

test('close --shutdown is ignored for a physical Android device', async () => {
  const shutdownTarget = vi.fn(async () => ({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  }));
  const { lifecycle } = createLifecycle({
    device: { ...device, id: 'R5CT123456A', kind: 'device' },
    shutdownTarget,
  });

  const result = await lifecycle.finalizeApplicationClose(
    finalizationInput({ shutdownTarget: true }),
  );

  expect(shutdownTarget).not.toHaveBeenCalled();
  expect(result).toEqual({});
});

test('an ordinary close tells the restore no emulator kill is coming', async () => {
  const sequence: string[] = [];
  const { lifecycle } = createLifecycle({
    restoreTestIme: async (_device, input) => {
      sequence.push(`restore:${input.shutdownTarget}`);
    },
    shutdownTarget: async () => {
      sequence.push('shutdown');
      return { success: true, exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const result = await lifecycle.finalizeApplicationClose(finalizationInput());

  expect(sequence).toEqual(['restore:false']);
  expect(result).toEqual({});
});

test('kill mode kills the target without resolving an interactor', async () => {
  const { calls, lifecycle } = createLifecycle();

  await lifecycle.closeApplication(closeInput({ mode: 'kill' }));

  expect(calls).toEqual([]);
  expect(mockKillAndroidApp).toHaveBeenCalledExactlyOnceWith(device, 'com.example.app');
});

test('a close without a mode force-stops through the interactor', async () => {
  const { calls, lifecycle } = createLifecycle();

  await lifecycle.closeApplication(closeInput());

  expect(calls).toEqual(['close:com.example.app']);
  expect(mockKillAndroidApp).not.toHaveBeenCalled();
});

test('kill mode without any target fails instead of reading as success', async () => {
  const { lifecycle } = createLifecycle();

  await expect(
    lifecycle.closeApplication(closeInput({ mode: 'kill', positionals: [] })),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(mockKillAndroidApp).not.toHaveBeenCalled();
});
