import { expect, test, vi } from 'vitest';
import type { OpenApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { bindAppleApplicationLifecycle } from './lifecycle.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-device',
  name: 'iPhone',
  kind: 'device',
  target: 'mobile',
  booted: true,
  iosPhysicalDeviceBackend: 'coredevice',
};

test.each(['coredevice', 'xctest'] as const)(
  'retains a physical iOS runner through relaunch and resets its target with the %s backend',
  async (iosPhysicalDeviceBackend) => {
    const selectedDevice = { ...device, iosPhysicalDeviceBackend };
    const signal = new AbortController().signal;
    const events: string[] = [];
    const interactor = {
      close: vi.fn(async () => {
        events.push('close');
      }),
      open: vi.fn(async () => {
        events.push('open');
      }),
    } as unknown as Interactor;
    const baseHost = platformRuntimeHostFixture();
    const stopRunnerSession = vi.fn(async () => {
      events.push('stop');
    });
    const prewarmRunnerSession = vi.fn(async () => {
      events.push('prewarm');
    });
    const notifyRunnerAppRelaunched = vi.fn(async () => {
      events.push('reset');
    });
    const host = {
      ...baseHost,
      localInteractors: { resolve: async () => interactor },
      appleApplications: {
        ...baseHost.appleApplications,
        stopRunnerSession,
        prewarmRunnerSession,
        notifyRunnerAppRelaunched,
      },
    } as unknown as PlatformRuntimeHost;
    const lifecycle = bindAppleApplicationLifecycle({ host, device: selectedDevice, signal });

    await lifecycle.openApplication(openInput());

    expect(events).toEqual(['close', 'open', 'prewarm', 'reset']);
    expect(stopRunnerSession).not.toHaveBeenCalled();
    expect(notifyRunnerAppRelaunched).toHaveBeenCalledWith(selectedDevice, {}, signal);
  },
);

test.each(['ipados', 'tvos', 'visionos'] as const)(
  'preserves runner restart semantics for a physical %s target',
  async (appleOs) => {
    const selectedDevice = { ...device, appleOs };
    const signal = new AbortController().signal;
    const events: string[] = [];
    const interactor = {
      close: vi.fn(async () => {
        events.push('close');
      }),
      open: vi.fn(async () => {
        events.push('open');
      }),
    } as unknown as Interactor;
    const baseHost = platformRuntimeHostFixture();
    const stopRunnerSession = vi.fn(async () => {
      events.push('stop');
    });
    const prewarmRunnerSession = vi.fn(async () => {
      events.push('prewarm');
    });
    const notifyRunnerAppRelaunched = vi.fn(async () => {
      events.push('reset');
    });
    const host = {
      ...baseHost,
      localInteractors: { resolve: async () => interactor },
      appleApplications: {
        ...baseHost.appleApplications,
        stopRunnerSession,
        prewarmRunnerSession,
        notifyRunnerAppRelaunched,
      },
    } as unknown as PlatformRuntimeHost;
    const lifecycle = bindAppleApplicationLifecycle({ host, device: selectedDevice, signal });

    await lifecycle.openApplication(openInput());

    expect(events).toEqual(['stop', 'close', 'open', 'prewarm']);
    expect(notifyRunnerAppRelaunched).not.toHaveBeenCalled();
  },
);

test('discards a retained physical iOS runner when relaunch fails and preserves the failure', async () => {
  const signal = new AbortController().signal;
  const events: string[] = [];
  const relaunchFailure = new Error('app failed to reopen');
  const interactor = {
    close: vi.fn(async () => {
      events.push('close');
    }),
    open: vi.fn(async () => {
      events.push('open');
      throw relaunchFailure;
    }),
  } as unknown as Interactor;
  const baseHost = platformRuntimeHostFixture();
  const stopRunnerSession = vi.fn(async () => {
    events.push('stop');
    throw new Error('runner cleanup failed');
  });
  const notifyRunnerAppRelaunched = vi.fn(async () => {
    events.push('reset');
  });
  const host = {
    ...baseHost,
    localInteractors: { resolve: async () => interactor },
    appleApplications: {
      ...baseHost.appleApplications,
      stopRunnerSession,
      notifyRunnerAppRelaunched,
    },
  } as unknown as PlatformRuntimeHost;
  const lifecycle = bindAppleApplicationLifecycle({ host, device, signal });

  await expect(lifecycle.openApplication(openInput())).rejects.toBe(relaunchFailure);

  expect(events).toEqual(['close', 'open', 'stop']);
  expect(stopRunnerSession).toHaveBeenCalledWith(device.id);
  expect(notifyRunnerAppRelaunched).not.toHaveBeenCalled();
});

function openInput(): OpenApplicationInput {
  return {
    target: 'com.example.app',
    positionals: ['com.example.app'],
    appBundleId: 'com.example.app',
    surface: 'app',
    hasExistingSession: true,
    relaunch: true,
    prewarmRunnerBeforeOpen: false,
    enableTestIme: false,
    stateDir: '/tmp/agent-device-lifecycle-test',
    runtimeHints: {},
    execution: {},
  };
}
