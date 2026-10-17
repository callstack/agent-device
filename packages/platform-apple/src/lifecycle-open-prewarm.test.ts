import { expect, test, vi } from 'vitest';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { AppError } from '@agent-device/kernel/errors';

import { bindAppleApplicationLifecycle } from './lifecycle.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import {
  coldSimulatorLifecycleHost,
  device,
  openInput,
  simulator,
  simulatorHost,
} from './lifecycle.fixtures.ts';

test.each([
  [true, 1],
  [false, 0],
] as const)(
  'a cold-booting Simulator open with prewarmRunnerOnColdBoot=%s warms the runner build cache %s time(s)',
  async (prewarmRunnerOnColdBoot, expectedCalls) => {
    const { host } = coldSimulatorLifecycleHost();
    const prewarmRunnerCache = vi.fn(async () => {});
    const signal = new AbortController().signal;
    const lifecycle = bindAppleApplicationLifecycle({
      host: {
        ...host,
        appleApplications: { ...host.appleApplications, prewarmRunnerCache },
      } as unknown as PlatformRuntimeHost,
      device: { ...simulator, booted: false },
      signal,
    });

    await lifecycle.prepareApplicationOpen({
      target: 'com.example.app',
      hasExistingSession: false,
      surface: 'app',
      prewarmRunnerOnColdBoot,
      execution: { requestId: 'open-request' },
    });

    expect(prewarmRunnerCache).toHaveBeenCalledTimes(expectedCalls);
    if (expectedCalls > 0) {
      expect(prewarmRunnerCache).toHaveBeenCalledWith(
        expect.objectContaining({ id: simulator.id }),
        { requestId: 'open-request' },
        signal,
      );
    }
  },
);

test('a Maestro app link on a Simulator resets the runner target it prewarmed before the URL dispatch', async () => {
  const events: string[] = [];
  const { host, notifyRunnerAppRelaunched } = simulatorHost({ events });
  const open = vi.fn(async (_app: string, _options?: Record<string, unknown>) => {
    events.push('open');
  });
  const signal = new AbortController().signal;
  const lifecycle = bindAppleApplicationLifecycle({
    host: {
      ...host,
      localInteractors: { resolve: async () => ({ open }) as unknown as Interactor },
    } as unknown as PlatformRuntimeHost,
    device: simulator,
    signal,
  });

  await lifecycle.openApplication({
    ...openInput(),
    positionals: ['com.example.app', 'https://example.com/deal'],
    relaunch: false,
    prewarmRunnerBeforeOpen: true,
  });

  expect(events).toEqual(['prewarm', 'open', 'reset']);
  expect(open).toHaveBeenCalledWith(
    'com.example.app',
    expect.objectContaining({ url: 'https://example.com/deal' }),
  );
  expect(notifyRunnerAppRelaunched).toHaveBeenCalledWith(simulator, {}, signal);
});

test('a blocking runner prewarm failure rejects the open before the app launches', async () => {
  const events: string[] = [];
  const prewarmFailure = new AppError(
    'COMMAND_FAILED',
    'Developer mode is disabled for Apple development tools',
    { hint: 'Run `sudo DevToolsSecurity -enable`.' },
  );
  const interactor = {
    open: vi.fn(async () => {
      events.push('open');
    }),
  } as unknown as Interactor;
  const baseHost = platformRuntimeHostFixture();
  const prewarmRunnerSession = vi.fn(async () => {
    throw prewarmFailure;
  });
  const host = {
    ...baseHost,
    localInteractors: { resolve: async () => interactor },
    appleApplications: { ...baseHost.appleApplications, prewarmRunnerSession },
  } as unknown as PlatformRuntimeHost;
  const signal = new AbortController().signal;
  const lifecycle = bindAppleApplicationLifecycle({ host, device, signal });

  await expect(
    lifecycle.openApplication({ ...openInput(), relaunch: false, prewarmRunnerBeforeOpen: true }),
  ).rejects.toBe(prewarmFailure);

  expect(prewarmRunnerSession).toHaveBeenCalledWith(device, {}, signal, true);
  expect(events).toEqual([]);
});

test('an open with no resolved app bundle id starts no runner prewarm', async () => {
  const events: string[] = [];
  const interactor = {
    open: vi.fn(async () => {
      events.push('open');
    }),
  } as unknown as Interactor;
  const baseHost = platformRuntimeHostFixture();
  const prewarmRunnerSession = vi.fn(async () => {});
  const host = {
    ...baseHost,
    localInteractors: { resolve: async () => interactor },
    appleApplications: { ...baseHost.appleApplications, prewarmRunnerSession },
  } as unknown as PlatformRuntimeHost;
  const lifecycle = bindAppleApplicationLifecycle({
    host,
    device,
    signal: new AbortController().signal,
  });

  await lifecycle.openApplication({
    ...openInput(),
    target: 'myapp://screen/to',
    positionals: ['myapp://screen/to'],
    appBundleId: undefined,
    relaunch: false,
  });

  expect(events).toEqual(['open']);
  expect(prewarmRunnerSession).not.toHaveBeenCalled();
});
