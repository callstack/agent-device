import { expect, test, vi } from 'vitest';
import type { OpenApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { bindAppleApplicationLifecycle } from './lifecycle.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

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
    expect(prewarmRunnerSession).toHaveBeenCalledWith(selectedDevice, {}, signal, false);
    expect(notifyRunnerAppRelaunched).toHaveBeenCalledWith(selectedDevice, {}, signal);
  },
);

test('starts an unawaited physical iOS first-open runner without a redundant health check', async () => {
  const signal = new AbortController().signal;
  const events: string[] = [];
  const interactor = {
    open: vi.fn(async () => {
      events.push('open');
    }),
  } as unknown as Interactor;
  const baseHost = platformRuntimeHostFixture();
  const prewarmRunnerSession = vi.fn(async () => {
    events.push('prewarm');
  });
  const host = {
    ...baseHost,
    localInteractors: { resolve: async () => interactor },
    appleApplications: {
      ...baseHost.appleApplications,
      prewarmRunnerSession,
    },
  } as unknown as PlatformRuntimeHost;
  const lifecycle = bindAppleApplicationLifecycle({ host, device, signal });

  await lifecycle.openApplication({
    ...openInput(),
    hasExistingSession: false,
    relaunch: false,
  });

  expect(events).toEqual(['open', 'prewarm']);
  expect(prewarmRunnerSession).toHaveBeenCalledWith(device, {}, signal, false, {
    healthCheck: false,
  });
});

test('preserves runner health proof for an unawaited physical iOS open in an existing session', async () => {
  const signal = new AbortController().signal;
  const events: string[] = [];
  const interactor = {
    open: vi.fn(async () => {
      events.push('open');
    }),
  } as unknown as Interactor;
  const baseHost = platformRuntimeHostFixture();
  const prewarmRunnerSession = vi.fn(async () => {
    events.push('prewarm');
  });
  const host = {
    ...baseHost,
    localInteractors: { resolve: async () => interactor },
    appleApplications: {
      ...baseHost.appleApplications,
      prewarmRunnerSession,
    },
  } as unknown as PlatformRuntimeHost;
  const lifecycle = bindAppleApplicationLifecycle({ host, device, signal });

  await lifecycle.openApplication({
    ...openInput(),
    hasExistingSession: true,
    relaunch: false,
  });

  expect(events).toEqual(['open', 'prewarm']);
  expect(prewarmRunnerSession).toHaveBeenCalledWith(device, {}, signal, false);
});

test('preserves the health check when physical iOS runner prewarm is awaited', async () => {
  const signal = new AbortController().signal;
  const events: string[] = [];
  const interactor = {
    open: vi.fn(async () => {
      events.push('open');
    }),
  } as unknown as Interactor;
  const baseHost = platformRuntimeHostFixture();
  const prewarmRunnerSession = vi.fn(async () => {
    events.push('prewarm');
  });
  const host = {
    ...baseHost,
    localInteractors: { resolve: async () => interactor },
    appleApplications: {
      ...baseHost.appleApplications,
      prewarmRunnerSession,
    },
  } as unknown as PlatformRuntimeHost;
  const lifecycle = bindAppleApplicationLifecycle({ host, device, signal });

  await lifecycle.openApplication({
    ...openInput(),
    hasExistingSession: false,
    relaunch: false,
    prewarmRunnerBeforeOpen: true,
  });

  expect(events).toEqual(['prewarm', 'open']);
  expect(prewarmRunnerSession).toHaveBeenCalledWith(device, {}, signal, true);
});

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
    expect(prewarmRunnerSession).toHaveBeenCalledWith(selectedDevice, {}, signal, false);
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

test('an explicit startup deadline waits for runner readiness before opening the app', async () => {
  const baseHost = platformRuntimeHostFixture();
  const ready = deferred<void>();
  const prewarmStarted = deferred<void>();
  const open = vi.fn(async () => {});
  const prewarmRunnerSession = vi.fn<
    PlatformRuntimeHost['appleApplications']['prewarmRunnerSession']
  >(async () => {
    prewarmStarted.resolve();
    await ready.promise;
  });
  const lifecycle = bindAppleApplicationLifecycle({
    device: { ...device, kind: 'simulator' },
    signal: new AbortController().signal,
    host: {
      ...baseHost,
      localInteractors: { resolve: async () => ({ open }) as unknown as Interactor },
      appleApplications: { ...baseHost.appleApplications, prewarmRunnerSession },
    },
  });
  const pending = lifecycle.openApplication({
    ...openInput(),
    relaunch: false,
    hasExistingSession: false,
    execution: { startupDeadlineAtMs: Date.now() + 600_000 },
  });
  await prewarmStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(open).not.toHaveBeenCalled();
  ready.resolve();
  await pending;
  expect(open).toHaveBeenCalledOnce();
  expect(prewarmRunnerSession.mock.calls[0]?.[3]).toBe(true);
});

test('prepare shares its timeout between simulator boot and runner preparation', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const baseHost = platformRuntimeHostFixture();
  const prepareRunner = vi.fn(baseHost.appleApplications.prepareRunner);
  const run = vi.fn<PlatformRuntimeHost['appleTools']['run']>(async (request) => {
    if (request.args.includes('bootstatus')) now.mockReturnValue(301_000);
    return {
      stdout: request.args.includes('list')
        ? JSON.stringify({
            devices: {
              ios: [{ udid: device.id, state: Date.now() === 1_000 ? 'Shutdown' : 'Booted' }],
            },
          })
        : '',
      stderr: '',
      exitCode: 0,
    };
  });
  try {
    const lifecycle = bindAppleApplicationLifecycle({
      host: {
        ...baseHost,
        appleTools: { ...baseHost.appleTools, run },
        appleApplications: { ...baseHost.appleApplications, prepareRunner },
      },
      device: { ...device, kind: 'simulator' },
      signal: new AbortController().signal,
    });
    await lifecycle.prepareAppleRunner({ timeoutMs: 600_000, execution: {} });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['bootstatus', device.id, '-b'], timeoutMs: 600_000 }),
      expect.any(AbortSignal),
    );
    expect(prepareRunner).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 300_000 }),
      expect.any(AbortSignal),
    );
  } finally {
    now.mockRestore();
  }
});
