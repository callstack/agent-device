import { afterEach, expect, test, vi } from 'vitest';
import type { LocalApplicationInteractorHost } from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
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

test('preserves a runtime launch URL duration after the admitted Android follow-up open', async () => {
  const opens: string[] = [];
  const localInteractors: LocalApplicationInteractorHost = {
    resolve: async () =>
      ({
        open: async (app: string) => {
          opens.push(app);
        },
        openDevice: async () => {},
        close: async () => {},
        setSetting: async () => {},
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
  vi.spyOn(Date, 'now')
    .mockReturnValueOnce(10)
    .mockReturnValueOnce(20)
    .mockReturnValueOnce(30)
    .mockReturnValueOnce(50);
  const lifecycle = bindAndroidApplicationLifecycle({
    host,
    device,
    signal: new AbortController().signal,
  });

  const outcome = await lifecycle.openApplication({
    target: 'com.example.app',
    positionals: ['com.example.app'],
    runtimeLaunchUrl: 'example://after-open',
    appBundleId: 'com.example.app',
    surface: 'app',
    hasExistingSession: false,
    relaunch: false,
    prewarmRunnerBeforeOpen: false,
    enableTestIme: false,
    stateDir: '/state',
    runtimeHints: {},
    execution: {},
  });

  expect(opens).toEqual(['com.example.app', 'example://after-open']);
  expect(outcome.timing.launchUrlDurationMs).toBe(20);
});
