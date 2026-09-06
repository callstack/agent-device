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

const simulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-simulator',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

function simulatorHost(overrides: {
  prewarmRunnerSession?: () => Promise<void>;
  hasLiveRunnerSession?: () => Promise<boolean>;
  events: string[];
}) {
  const interactor = {
    close: vi.fn(async () => {
      overrides.events.push('close');
    }),
    open: vi.fn(async () => {
      overrides.events.push('open');
    }),
  } as unknown as Interactor;
  const baseHost = platformRuntimeHostFixture();
  const prewarmRunnerSession = vi.fn(
    overrides.prewarmRunnerSession ??
      (async () => {
        overrides.events.push('prewarm');
      }),
  );
  const notifyRunnerAppRelaunched = vi.fn(async () => {
    overrides.events.push('reset');
  });
  const hasLiveRunnerSession = vi.fn(overrides.hasLiveRunnerSession ?? (async () => false));
  const host = {
    ...baseHost,
    clock: { ...baseHost.clock, sleep: async () => {} },
    localInteractors: { resolve: async () => interactor },
    appleApplications: {
      ...baseHost.appleApplications,
      prewarmRunnerSession,
      notifyRunnerAppRelaunched,
      hasLiveRunnerSession,
    },
  } as unknown as PlatformRuntimeHost;
  return { host, prewarmRunnerSession, notifyRunnerAppRelaunched, hasLiveRunnerSession };
}

test('a Simulator open whose plan is observation-only starts no runner and reports demand none', async () => {
  const events: string[] = [];
  const { host, prewarmRunnerSession, notifyRunnerAppRelaunched } = simulatorHost({ events });
  const lifecycle = bindAppleApplicationLifecycle({
    host,
    device: simulator,
    signal: new AbortController().signal,
  });

  const outcome = await lifecycle.openApplication({
    ...openInput(),
    execution: { plannedOperations: ['captureSnapshot', 'findText', 'captureScreenshot'] },
  });

  expect(outcome.timing.runnerDemand).toBe('none');
  expect(outcome.timing.runnerPrewarmScheduled).toBeUndefined();
  expect(prewarmRunnerSession).not.toHaveBeenCalled();
  expect(notifyRunnerAppRelaunched).not.toHaveBeenCalled();
  expect(events).toEqual(['open']);
});

test.each([
  ['an unknown plan', undefined, 'possible'],
  ['a plan that needs the runner', ['captureSnapshot', 'tapPoint'], 'required'],
] as const)(
  'a Simulator relaunch with %s schedules the runner prewarm without awaiting it',
  async (_name, plan, expectedDemand) => {
    const events: string[] = [];
    let releasePrewarm = () => {};
    const { host, prewarmRunnerSession, notifyRunnerAppRelaunched } = simulatorHost({
      events,
      // A prewarm that never finishes inside the open: if the open awaited runner readiness
      // this test would time out instead of passing.
      prewarmRunnerSession: () =>
        new Promise<void>((resolve) => {
          releasePrewarm = resolve;
        }),
    });
    const lifecycle = bindAppleApplicationLifecycle({
      host,
      device: simulator,
      signal: new AbortController().signal,
    });

    const opened = lifecycle.openApplication({
      ...openInput(),
      relaunch: true,
      execution: { plannedOperations: plan },
    });
    const outcome = await Promise.race([
      opened,
      new Promise<'awaited-runner-readiness'>((resolve) =>
        setTimeout(() => resolve('awaited-runner-readiness'), 500),
      ),
    ]);
    releasePrewarm();

    expect(outcome).not.toBe('awaited-runner-readiness');
    if (outcome === 'awaited-runner-readiness') return;
    expect(outcome.timing.runnerDemand).toBe(expectedDemand);
    expect(outcome.timing.runnerPrewarmScheduled).toBe(true);
    expect(outcome.timing.runnerPrewarmWaited).toBe(false);
    expect(prewarmRunnerSession).toHaveBeenCalledOnce();
    // The starting runner has no cached target, so nothing is reset and nothing is awaited.
    expect(notifyRunnerAppRelaunched).not.toHaveBeenCalled();
    expect(events).toEqual(['open']);
  },
);

test('a Simulator relaunch resets the target only on a runner that is already alive', async () => {
  const events: string[] = [];
  const { host, notifyRunnerAppRelaunched, hasLiveRunnerSession } = simulatorHost({
    events,
    hasLiveRunnerSession: async () => true,
  });
  const signal = new AbortController().signal;
  const lifecycle = bindAppleApplicationLifecycle({ host, device: simulator, signal });

  await lifecycle.openApplication({ ...openInput(), relaunch: true });

  expect(hasLiveRunnerSession).toHaveBeenCalledWith(simulator, {});
  expect(notifyRunnerAppRelaunched).toHaveBeenCalledWith(simulator, {}, signal);
  expect(events).toEqual(['prewarm', 'open', 'reset']);
});

test('a physical iOS relaunch still awaits the runner prewarm and ignores the plan', async () => {
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
  const host = {
    ...baseHost,
    localInteractors: { resolve: async () => interactor },
    appleApplications: {
      ...baseHost.appleApplications,
      prewarmRunnerSession: vi.fn(async () => {
        events.push('prewarm');
      }),
      notifyRunnerAppRelaunched: vi.fn(async () => {
        events.push('reset');
      }),
      hasLiveRunnerSession: vi.fn(async () => false),
    },
  } as unknown as PlatformRuntimeHost;
  const lifecycle = bindAppleApplicationLifecycle({
    host,
    device,
    signal: new AbortController().signal,
  });

  const outcome = await lifecycle.openApplication({
    ...openInput(),
    execution: { plannedOperations: ['captureSnapshot'] },
  });

  expect(outcome.timing.runnerDemand).toBeUndefined();
  expect(outcome.timing.runnerPrewarmWaited).toBe(true);
  expect(events).toEqual(['close', 'open', 'prewarm', 'reset']);
});
