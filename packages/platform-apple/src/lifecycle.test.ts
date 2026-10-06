import { beforeEach, expect, test, vi } from 'vitest';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

import { bindAppleApplicationLifecycle } from './lifecycle.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import type { LaunchObservation } from './snapshot-observability.ts';
import { alertNotFound, CONFIRMATION } from './launch-confirmation.fixtures.ts';
import {
  COMING_UP,
  LAUNCH_URL,
  OBSERVABLE,
  SPAWN_TIMEOUT,
  UNOBSERVABLE,
  device,
  launchUrlInput,
  launchUrlSimulator,
  openInput,
  resetUrlOwner,
  simulator,
  simulatorHost,
  urlOwner,
} from './lifecycle.fixtures.ts';

vi.mock('./core/app-resolution.ts', async () => {
  const fixtures = await import('./lifecycle.fixtures.ts');
  return {
    resolveIosSimulatorDeepLinkBundleId: async () => await fixtures.urlOwner.resolve(),
  };
});

beforeEach(() => {
  resetUrlOwner();
});

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

test.each([true, false])(
  'close finalization delegates the runner release to the runner module with retain=%s (#2552)',
  async (retainRunner) => {
    const signal = new AbortController().signal;
    const baseHost = platformRuntimeHostFixture();
    const releaseRunnerOnClose = vi.fn(async () => {});
    const dismissCloseAlerts = vi.fn(async () => {});
    const host = {
      ...baseHost,
      appleApplications: {
        ...baseHost.appleApplications,
        releaseRunnerOnClose,
        dismissCloseAlerts,
      },
    } as unknown as PlatformRuntimeHost;
    const lifecycle = bindAppleApplicationLifecycle({ host, device, signal });

    await lifecycle.finalizeApplicationClose({ surface: 'app', retainRunner, stateDir: '/tmp' });

    expect(releaseRunnerOnClose).toHaveBeenCalledWith(device.id, { retain: retainRunner });
    expect(dismissCloseAlerts).toHaveBeenCalled();
  },
);

test('daemon-shutdown finalization dismisses alerts and defers the runner release to the gateway (#2552)', async () => {
  const signal = new AbortController().signal;
  const baseHost = platformRuntimeHostFixture();
  const releaseRunnerOnClose = vi.fn(async () => {});
  const dismissCloseAlerts = vi.fn(async () => {});
  const host = {
    ...baseHost,
    appleApplications: {
      ...baseHost.appleApplications,
      releaseRunnerOnClose,
      dismissCloseAlerts,
    },
  } as unknown as PlatformRuntimeHost;
  const lifecycle = bindAppleApplicationLifecycle({ host, device, signal });

  await lifecycle.finalizeApplicationClose({
    surface: 'app',
    retainRunner: true,
    stateDir: '/tmp',
    daemonShutdown: true,
  });

  expect(releaseRunnerOnClose).not.toHaveBeenCalled();
  expect(dismissCloseAlerts).toHaveBeenCalled();
});

test('prepare shares one startup budget across the Simulator boot and the runner preparation', async () => {
  vi.useFakeTimers();
  try {
    const startedAtMs = 1_000_000;
    vi.setSystemTime(startedAtMs);
    const { host, calls, prepareRunner } = coldSimulatorLifecycleHost({
      onBoot: () => vi.setSystemTime(startedAtMs + 10_000),
      onBootstatus: () => vi.setSystemTime(startedAtMs + 50_000),
    });
    const lifecycle = bindAppleApplicationLifecycle({
      host,
      device: { ...simulator, booted: false },
      signal: new AbortController().signal,
    });

    await lifecycle.prepareAppleRunner({ timeoutMs: 100_000, execution: {} });

    // The boot wait gets what the boot left; the runner gets what the boot wait left.
    expect(calls.find((call) => call.args.includes('bootstatus'))?.timeoutMs).toBe(90_000);
    expect(prepareRunner).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: simulator.id }),
      { timeoutMs: 50_000, execution: {} },
      expect.anything(),
    );
  } finally {
    vi.useRealTimers();
  }
});

test('open forwards its startup deadline to the Simulator boot wait', async () => {
  vi.useFakeTimers();
  try {
    const startedAtMs = 1_000_000;
    vi.setSystemTime(startedAtMs);
    const { host, calls } = coldSimulatorLifecycleHost({
      onBoot: () => vi.setSystemTime(startedAtMs + 5_000),
    });
    const lifecycle = bindAppleApplicationLifecycle({
      host,
      device: { ...simulator, booted: false },
      signal: new AbortController().signal,
    });

    await lifecycle.prepareApplicationOpen({
      target: 'com.example.app',
      hasExistingSession: false,
      surface: 'app',
      prewarmRunnerOnColdBoot: false,
      execution: { startupDeadlineAtMs: startedAtMs + 45_000 },
    });

    expect(calls.find((call) => call.args.includes('bootstatus'))?.timeoutMs).toBe(40_000);
  } finally {
    vi.useRealTimers();
  }
});

/** A Shutdown Simulator host whose boot and bootstatus calls run the given hooks before succeeding. */
function coldSimulatorLifecycleHost(hooks: { onBoot?: () => void; onBootstatus?: () => void }) {
  const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  let state = 'Shutdown';
  const run: PlatformRuntimeHost['appleTools']['run'] = vi.fn(async (request) => {
    calls.push({ args: [...request.args], timeoutMs: request.timeoutMs });
    if (request.args.includes('list')) {
      return {
        stdout: JSON.stringify({ devices: { ios: [{ udid: simulator.id, state }] } }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (request.args.includes('boot')) {
      hooks.onBoot?.();
      state = 'Booted';
    }
    if (request.args.includes('bootstatus')) hooks.onBootstatus?.();
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const prepareRunner = vi.fn(async () => ({ runner: {}, connectMs: 0, healthCheckMs: 0 }));
  const base = platformRuntimeHostFixture();
  const host = {
    ...base,
    appleTools: { isXcrunAvailable: async () => true, run },
    appleApplications: { ...base.appleApplications, prepareRunner },
  } as unknown as PlatformRuntimeHost;
  return { host, calls, prepareRunner };
}

test('a Simulator open whose plan is observation-only starts no runner, releases a speculative one, and reports demand none', async () => {
  const events: string[] = [];
  const { host, prewarmRunnerSession, notifyRunnerAppRelaunched, releaseSpeculativeRunner } =
    simulatorHost({ events });
  const lifecycle = bindAppleApplicationLifecycle({
    host,
    device: simulator,
    signal: new AbortController().signal,
  });

  const outcome = await lifecycle.openApplication({
    ...openInput(),
    execution: { plannedOperations: ['captureSnapshot', 'captureScreenshot'] },
  });

  expect(outcome.timing.runnerDemand).toBe('none');
  expect(outcome.timing.runnerPrewarmScheduled).toBeUndefined();
  expect(prewarmRunnerSession).not.toHaveBeenCalled();
  expect(notifyRunnerAppRelaunched).not.toHaveBeenCalled();
  // The release goes to the runner owner before the app opens and is never awaited by the open.
  expect(releaseSpeculativeRunner).toHaveBeenCalledExactlyOnceWith(simulator, {
    plannedOperations: ['captureSnapshot', 'captureScreenshot'],
  });
  expect(events).toEqual(['release', 'open']);
});

test.each([
  ['an unknown plan', undefined, 'possible'],
  ['a plan that needs the runner', ['captureSnapshot', 'tapPoint'], 'required'],
] as const)(
  'a Simulator relaunch with %s schedules the runner prewarm without awaiting it',
  async (_name, plan, expectedDemand) => {
    const events: string[] = [];
    let releasePrewarm = () => {};
    const { host, prewarmRunnerSession, notifyRunnerAppRelaunched, releaseSpeculativeRunner } =
      simulatorHost({
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
    // Only a proven observation-only plan releases; a plan that may need the runner keeps it.
    expect(releaseSpeculativeRunner).not.toHaveBeenCalled();
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

test('a Simulator open lets the launched app become observable instead of sleeping a fixed settle', async () => {
  const events: string[] = [];
  const { host } = simulatorHost({ events });
  const sleep = vi.fn(async () => {
    events.push('sleep');
  });
  const awaitObservable = vi.fn(async () => {
    events.push('observe');
    return { observation: 'observable' } as const;
  });
  const signal = new AbortController().signal;
  const lifecycle = bindAppleApplicationLifecycle({
    host: { ...host, clock: { ...host.clock, sleep } } as unknown as PlatformRuntimeHost,
    device: simulator,
    signal,
    observation: { awaitObservable },
  });

  const outcome = await lifecycle.openApplication({
    ...openInput(),
    execution: { plannedOperations: ['captureSnapshot'] },
  });

  expect(awaitObservable).toHaveBeenCalledWith(simulator, 'com.example.app', signal);
  expect(outcome.timing.postOpenObservation).toBe('observable');
  expect(events).toEqual(['release', 'open', 'observe']);
});

test('a Simulator whose bridge cannot answer keeps the fixed settle', async () => {
  const events: string[] = [];
  const { host } = simulatorHost({ events });
  const sleep = vi.fn(async () => {
    events.push('sleep');
  });
  const lifecycle = bindAppleApplicationLifecycle({
    host: { ...host, clock: { ...host.clock, sleep } } as unknown as PlatformRuntimeHost,
    device: simulator,
    signal: new AbortController().signal,
    observation: {
      awaitObservable: async () => ({ observation: 'unobservable', proof: 'launch-transition' }),
    },
  });

  const outcome = await lifecycle.openApplication({
    ...openInput(),
    execution: { plannedOperations: ['captureSnapshot'] },
  });

  expect(outcome.timing.postOpenObservation).toBe('unobservable');
  expect(events).toEqual(['release', 'open', 'sleep']);
});

test('a tvOS Simulator relaunch keeps the awaited prewarm and asks for no observation', async () => {
  const events: string[] = [];
  const { host, prewarmRunnerSession, notifyRunnerAppRelaunched } = simulatorHost({ events });
  const awaitObservable = vi.fn(async () => ({ observation: 'observable' }) as const);
  const tvos = { ...simulator, appleOs: 'tvos', target: 'tv' } as const satisfies DeviceInfo;
  const lifecycle = bindAppleApplicationLifecycle({
    host,
    device: tvos,
    signal: new AbortController().signal,
    observation: { awaitObservable },
  });

  const outcome = await lifecycle.openApplication({
    ...openInput(),
    relaunch: true,
    execution: { plannedOperations: ['captureSnapshot'] },
  });

  expect(outcome.timing.runnerDemand).toBeUndefined();
  expect(outcome.timing.runnerPrewarmWaited).toBe(true);
  expect(outcome.timing.postOpenObservation).toBeUndefined();
  expect(awaitObservable).not.toHaveBeenCalled();
  expect(prewarmRunnerSession).toHaveBeenCalledOnce();
  expect(notifyRunnerAppRelaunched).not.toHaveBeenCalled();
});

test('a launch URL the bridge sees land in the app never reaches the runner', async () => {
  const { lifecycle, events, interactor, releaseSpeculativeRunner, prewarmRunnerSession } =
    launchUrlSimulator(async () => {
      throw alertNotFound();
    });

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome.launchConfirmation).toBeUndefined();
  expect(outcome.timing.runnerDemand).toBe('none');
  expect(releaseSpeculativeRunner).toHaveBeenCalledOnce();
  expect(prewarmRunnerSession).not.toHaveBeenCalled();
  expect(interactor.readAlert).not.toHaveBeenCalled();
  expect(events).toEqual(['release', `open ${LAUNCH_URL}`, 'observe observable']);
});

/** Verdicts that prove nothing about whether the app came up, so the sheet is still read. */
const DISCOVERY_DEADLINE_TIMEOUT: LaunchObservation = {
  observation: 'probe-failed',
  failure: { source: 'target', code: 'COMMAND_FAILED' },
};
const TARGET_PROBE_FAILED: LaunchObservation = {
  observation: 'probe-failed',
  failure: {
    source: 'target',
    code: 'COMMAND_FAILED',
    reason: 'simulator-target-probe-failed',
  },
};
const BRIDGE_CIRCUIT: LaunchObservation = {
  observation: 'probe-failed',
  failure: { source: 'circuit' },
};

test.each([
  ['the bridge circuit is open', BRIDGE_CIRCUIT, BRIDGE_CIRCUIT],
  ['target discovery fails on its deadline', DISCOVERY_DEADLINE_TIMEOUT, OBSERVABLE],
  ['the target probe fails outright', TARGET_PROBE_FAILED, OBSERVABLE],
])(
  'a confirmable launch whose bridge verdict is %s still reads and answers the sheet',
  async (_name, beforeAnswer, afterAnswer) => {
    const { lifecycle, events, interactor } = launchUrlSimulator(
      async () => CONFIRMATION,
      [beforeAnswer, afterAnswer],
    );

    const outcome = await lifecycle.openApplication(launchUrlInput());

    expect(outcome.launchConfirmation).toBe('accepted');
    expect(outcome.timing.runnerDemand).toBe('required');
    expect(interactor.readAlert).toHaveBeenCalledOnce();
    expect(outcome.timing.postOpenObservation).toBe(afterAnswer.observation);
    // A verdict the bridge could not produce keeps its typed failure, so the open still says why
    // the app came back unreadable.
    expect(outcome.timing.postOpenObservationFailure).toEqual(
      afterAnswer.observation === 'probe-failed' ? afterAnswer.failure : undefined,
    );
    expect(events).toEqual([
      'release',
      `open ${LAUNCH_URL}`,
      'observe probe-failed',
      'alert get',
      'alert accept',
      `observe ${afterAnswer.observation}`,
    ]);
  },
);

test('a launch URL held behind a confirmation for the session app is accepted and reported', async () => {
  const { lifecycle, events, resolutions } = launchUrlSimulator(
    async () => CONFIRMATION,
    [UNOBSERVABLE, OBSERVABLE],
  );

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome.launchConfirmation).toBe('accepted');
  // One resolution dispatches the open; one more serves both the alert read and the accept.
  expect(resolutions()).toBe(2);
  expect(outcome.timing.runnerDemand).toBe('required');
  expect(outcome.timing.postOpenObservation).toBe('observable');
  expect(events).toEqual([
    'release',
    `open ${LAUNCH_URL}`,
    'observe unobservable',
    'alert get',
    'alert accept',
    'observe observable',
  ]);
});

test('the reported settle spans both observations and the answer between them', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { lifecycle } = launchUrlSimulator(
      async () => {
        vi.advanceTimersByTime(100);
        return CONFIRMATION;
      },
      [UNOBSERVABLE, OBSERVABLE],
      {
        owner: async () => {
          vi.advanceTimersByTime(100);
          return 'com.example.app';
        },
      },
    );

    const outcome = await lifecycle.openApplication(launchUrlInput());

    expect(outcome.launchConfirmation).toBe('accepted');
    expect(outcome.timing.postOpenSettleDurationMs).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ['finds no alert', alertNotFound()],
  [
    'cannot reach the runner',
    new AppError('COMMAND_FAILED', 'runner unavailable', { reason: 'runner-start-failed' }),
  ],
])(
  'an unobservable launch whose alert read %s returns the open as it was',
  async (_case, failure) => {
    const { lifecycle, events } = launchUrlSimulator(async () => {
      throw failure;
    }, [UNOBSERVABLE]);

    const outcome = await lifecycle.openApplication(launchUrlInput());

    expect(outcome.launchConfirmation).toBeUndefined();
    expect(outcome.timing.runnerDemand).toBe('required');
    expect(outcome.timing.postOpenObservation).toBe('unobservable');
    expect(events).toEqual(['release', `open ${LAUNCH_URL}`, 'observe unobservable', 'alert get']);
  },
);

test.each([
  [
    'the runner interactor cannot be resolved',
    {
      resolveInteractor: async () => {
        throw SPAWN_TIMEOUT;
      },
    },
    ['release', `open ${LAUNCH_URL}`, 'observe unobservable'],
  ],
  [
    'the URL owner lookup rejects',
    {
      owner: async () => {
        throw SPAWN_TIMEOUT;
      },
    },
    ['release', `open ${LAUNCH_URL}`, 'observe unobservable', 'alert get'],
  ],
])('an unobservable launch where %s returns the open as it was', async (_case, legs, expected) => {
  const { lifecycle, events } = launchUrlSimulator(async () => CONFIRMATION, [UNOBSERVABLE], legs);

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome.launchConfirmation).toBeUndefined();
  expect(outcome.timing.postOpenObservation).toBe('unobservable');
  expect(events).toEqual(expected);
});

test('an accept that dies with the runner session hands the URL over again and reads once more', async () => {
  let accepts = 0;
  const readAlert = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockResolvedValueOnce(CONFIRMATION)
    .mockRejectedValueOnce(SPAWN_TIMEOUT)
    .mockResolvedValue(CONFIRMATION);
  const { lifecycle, events } = launchUrlSimulator(
    readAlert,
    [UNOBSERVABLE, UNOBSERVABLE, OBSERVABLE],
    {
      acceptAlert: async () => {
        accepts += 1;
        if (accepts === 1) throw SPAWN_TIMEOUT;
        return {};
      },
    },
  );

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome.launchConfirmation).toBe('accepted');
  expect(outcome.timing.postOpenObservation).toBe('observable');
  // The re-dispatch hands the URL as its own open target, the way the follow-up open does.
  expect(events).toEqual([
    'release',
    `open ${LAUNCH_URL}`,
    'observe unobservable',
    'alert get',
    'alert accept',
    'alert get',
    'observe unobservable',
    'open',
    'alert get',
    'alert accept',
    'observe observable',
  ]);
});

test.each([
  ['still coming up', COMING_UP],
  ['observable', OBSERVABLE],
  ['not running', UNOBSERVABLE],
])(
  'a failed accept rejects a persistent launch prompt while the app is %s',
  async (_name, afterAnswer) => {
    const { lifecycle, interactor, events } = launchUrlSimulator(
      async () => CONFIRMATION,
      [BRIDGE_CIRCUIT, afterAnswer],
      {
        acceptAlert: async () => {
          throw new AppError('COMMAND_FAILED', 'alert accept exhausted its deadline', {
            runnerErrorCode: 'ALERT_DEADLINE_EXCEEDED',
          });
        },
      },
    );

    await expect(lifecycle.openApplication(launchUrlInput())).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'launch_confirmation_unanswered', appBundleId: 'com.example.app' },
    });
    expect(interactor.acceptAlert).toHaveBeenCalledOnce();
    expect(interactor.readAlert).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event === 'open' || event === `open ${LAUNCH_URL}`)).toEqual([
      `open ${LAUNCH_URL}`,
    ]);
  },
);

test.each([
  {
    name: 'absent',
    readAfterFailure: async () => {
      throw alertNotFound();
    },
  },
  {
    name: 'unreadable',
    readAfterFailure: async () => {
      throw SPAWN_TIMEOUT;
    },
  },
  {
    name: 'replaced by the same title with unrelated buttons',
    readAfterFailure: async () => ({ message: CONFIRMATION.message, items: ['Allow', 'Deny'] }),
  },
  {
    name: 'replaced by another launch confirmation',
    readAfterFailure: async () => ({ ...CONFIRMATION, message: 'Open in “Other App”?' }),
  },
])(
  'a failed accept with its prompt $name preserves launch-transition policy',
  async ({ readAfterFailure }) => {
    const readAlert = vi.fn(readAfterFailure).mockResolvedValueOnce(CONFIRMATION);
    const { lifecycle, interactor, events } = launchUrlSimulator(
      readAlert,
      [BRIDGE_CIRCUIT, COMING_UP],
      {
        acceptAlert: async () => {
          throw SPAWN_TIMEOUT;
        },
      },
    );

    const outcome = await lifecycle.openApplication(launchUrlInput());

    expect(outcome.launchConfirmation).toBeUndefined();
    expect(outcome.timing.postOpenObservation).toBe('unobservable');
    expect(interactor.acceptAlert).toHaveBeenCalledOnce();
    expect(interactor.readAlert).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event === 'open' || event === `open ${LAUNCH_URL}`)).toEqual([
      `open ${LAUNCH_URL}`,
    ]);
  },
);

test('an accept leaving a launch-transition window open stays green and re-hands nothing', async () => {
  const { lifecycle, events } = launchUrlSimulator(
    async () => CONFIRMATION,
    [UNOBSERVABLE, COMING_UP],
  );

  const outcome = await lifecycle.openApplication(launchUrlInput());

  // The window proves only that the app was still coming up, which no second hand-off can fix.
  expect(outcome.launchConfirmation).toBe('accepted');
  expect(outcome.timing.postOpenObservation).toBe('unobservable');
  expect(events).toEqual([
    'release',
    `open ${LAUNCH_URL}`,
    'observe unobservable',
    'alert get',
    'alert accept',
    'observe unobservable',
  ]);
});

test('a launch URL handed over twice that still leaves no process fails the open', async () => {
  const readAlert = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockResolvedValueOnce(CONFIRMATION)
    .mockRejectedValueOnce(SPAWN_TIMEOUT)
    .mockResolvedValueOnce(CONFIRMATION)
    .mockRejectedValueOnce(SPAWN_TIMEOUT);
  const { lifecycle, events } = launchUrlSimulator(
    readAlert,
    Array.from({ length: 3 }, () => UNOBSERVABLE),
    {
      acceptAlert: async () => {
        throw SPAWN_TIMEOUT;
      },
    },
  );

  const failure = await lifecycle
    .openApplication(launchUrlInput())
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(AppError);
  expect((failure as AppError).details).toMatchObject({
    reason: 'launch_confirmation_unanswered',
    appBundleId: 'com.example.app',
  });
  expect(events.filter((event) => event === 'open' || event === `open ${LAUNCH_URL}`)).toEqual([
    `open ${LAUNCH_URL}`,
    'open',
  ]);
});

test('a launch URL whose scheme another app owns fails the open without accepting it', async () => {
  urlOwner.resolve = async () => 'com.example.other';
  const { lifecycle, interactor } = launchUrlSimulator(async () => CONFIRMATION, [UNOBSERVABLE]);

  const failure = await lifecycle
    .openApplication(launchUrlInput())
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(AppError);
  expect((failure as AppError).details).toMatchObject({
    reason: 'launch_confirmation_foreign_app',
    foreignAppBundleId: 'com.example.other',
    sessionAppBundleId: 'com.example.app',
  });
  expect(interactor.acceptAlert).not.toHaveBeenCalled();
});

test.each([
  ['no launch URL', undefined],
  ['a web launch URL', 'https://example.com/automation'],
])('a Simulator open with %s never reads an alert', async (_name, runtimeLaunchUrl) => {
  const { lifecycle, interactor } = launchUrlSimulator(async () => ({}), [UNOBSERVABLE]);

  const outcome = await lifecycle.openApplication({ ...launchUrlInput(), runtimeLaunchUrl });

  expect(outcome.launchConfirmation).toBeUndefined();
  expect(outcome.timing.runnerDemand).toBe('none');
  expect(interactor.readAlert).not.toHaveBeenCalled();
});

test('a physical iOS launch URL never reads an alert', async () => {
  const { interactor } = launchUrlSimulator(async () => ({}), [UNOBSERVABLE]);
  const lifecycle = bindAppleApplicationLifecycle({
    host: {
      ...platformRuntimeHostFixture(),
      localInteractors: { resolve: async () => interactor },
    } as unknown as PlatformRuntimeHost,
    device,
    signal: new AbortController().signal,
  });

  const outcome = await lifecycle.openApplication({ ...launchUrlInput(), relaunch: false });

  expect(outcome.launchConfirmation).toBeUndefined();
  expect(interactor.readAlert).not.toHaveBeenCalled();
});
