import { afterEach, expect, test, vi } from 'vitest';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { bindAppleApplicationLifecycle } from './lifecycle.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import { device, openInput, simulator } from './lifecycle.fixtures.ts';

const MACOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

afterEach(() => {
  vi.useRealTimers();
});

type OpenCall = Readonly<{ app: string; options?: Record<string, unknown> }>;

/** Completes after the caller has had a chance to run ahead, so only an awaited step is recorded first. */
const settleLater = async () => await new Promise<void>((resolve) => setTimeout(resolve, 0));

function lifecycleHost(params: {
  events: string[];
  hasLiveRunnerSession?: boolean;
  prewarmRunnerSession?: () => Promise<void>;
}) {
  const openCalls: OpenCall[] = [];
  const interactor = {
    setSetting: vi.fn(async () => {}),
    close: vi.fn(async (app: string) => {
      params.events.push(`close:${app}`);
    }),
    open: vi.fn(async (app: string, options?: Record<string, unknown>) => {
      openCalls.push({ app, options });
      params.events.push(options?.url ? `open:${app} ${String(options.url)}` : `open:${app}`);
    }),
  } as unknown as Interactor;
  const baseHost = platformRuntimeHostFixture();
  const appleApplications = {
    ...baseHost.appleApplications,
    stopRunnerSession: vi.fn(async (deviceId: string) => {
      await settleLater();
      params.events.push(`stop-runner:${deviceId}`);
    }),
    prewarmRunnerSession: vi.fn(
      params.prewarmRunnerSession ??
        (async () => {
          params.events.push('prewarm');
        }),
    ),
    notifyRunnerAppRelaunched: vi.fn(async () => {
      params.events.push('reset-runner-target');
    }),
    hasLiveRunnerSession: vi.fn(async () => params.hasLiveRunnerSession ?? false),
    releaseRunnerOnClose: vi.fn(async (deviceId: string, options: { retain: boolean }) => {
      await settleLater();
      params.events.push(`release-runner:${deviceId}:${options.retain ? 'retain' : 'stop'}`);
    }),
    dismissCloseAlerts: vi.fn(async () => {
      params.events.push('dismiss-alerts');
    }),
  };
  const host = {
    ...baseHost,
    clock: { ...baseHost.clock, sleep: async () => {} },
    localInteractors: { resolve: async () => interactor },
    appleApplications,
  } as unknown as PlatformRuntimeHost;
  return { host, openCalls, appleApplications };
}

function bind(host: PlatformRuntimeHost, selected: DeviceInfo) {
  return bindAppleApplicationLifecycle({
    host,
    device: selected,
    signal: new AbortController().signal,
  });
}

test('a Simulator relaunch collapses into one open that terminates the running app', async () => {
  const events: string[] = [];
  const { host, openCalls, appleApplications } = lifecycleHost({
    events,
    hasLiveRunnerSession: true,
  });

  await bind(host, simulator).openApplication(openInput());

  expect(events).toEqual(['prewarm', 'open:com.example.app', 'reset-runner-target']);
  expect(openCalls[0]?.options?.terminateRunningApp).toBe(true);
  expect(appleApplications.stopRunnerSession).not.toHaveBeenCalled();
});

test('a Simulator relaunch with a launch URL delegates termination to the URL open', async () => {
  const events: string[] = [];
  const { host, openCalls } = lifecycleHost({ events });

  await bind(host, simulator).openApplication({
    ...openInput(),
    positionals: ['com.example.app', 'https://example.com/deal'],
  });

  expect(events.filter((event) => event.startsWith('open:') || event.startsWith('close:'))).toEqual(
    ['open:com.example.app https://example.com/deal'],
  );
  expect(openCalls[0]?.options?.terminateRunningApp).toBe(true);
});

test('a Simulator relaunch that clears app state closes before it opens', async () => {
  const events: string[] = [];
  const { host, openCalls } = lifecycleHost({ events });

  await bind(host, simulator).openApplication({
    ...openInput(),
    execution: { clearAppState: true },
  });

  expect(events.filter((event) => event.startsWith('open:') || event.startsWith('close:'))).toEqual(
    ['close:com.example.app', 'open:com.example.app'],
  );
  expect(openCalls[0]?.options?.terminateRunningApp).toBeUndefined();
});

test('a physical iOS relaunch waits for the runner prewarm and reports its timing', async () => {
  vi.useFakeTimers({ now: 1_000 });
  const events: string[] = [];
  const { host, appleApplications } = lifecycleHost({
    events,
    prewarmRunnerSession: () =>
      new Promise<void>((resolve) => {
        events.push('prewarm-start');
        setTimeout(() => {
          events.push('prewarm-finish');
          resolve();
        }, 250);
      }),
  });

  const opening = bind(host, device).openApplication(openInput());
  await vi.advanceTimersByTimeAsync(250);
  const outcome = await opening;

  expect(events).toEqual([
    'close:com.example.app',
    'open:com.example.app',
    'prewarm-start',
    'prewarm-finish',
    'reset-runner-target',
  ]);
  expect(appleApplications.stopRunnerSession).not.toHaveBeenCalled();
  expect(outcome.timing).toMatchObject({
    runnerPrewarmKind: 'session',
    runnerPrewarmScheduled: true,
    runnerPrewarmWaited: true,
    runnerPrewarmDurationMs: 250,
  });
});

test('a physical iOS relaunch without an existing session closes then opens the target app', async () => {
  const events: string[] = [];
  const { host, appleApplications } = lifecycleHost({ events });

  await bind(host, device).openApplication({ ...openInput(), hasExistingSession: false });

  expect(events).toEqual([
    'close:com.example.app',
    'open:com.example.app',
    'prewarm',
    'reset-runner-target',
  ]);
  expect(appleApplications.stopRunnerSession).not.toHaveBeenCalled();
});

test.each([
  { name: 'a physical iOS device', selected: device, stopsRunner: true },
  { name: 'a macOS host', selected: MACOS_DEVICE, stopsRunner: true },
  { name: 'an iOS Simulator', selected: simulator, stopsRunner: false },
])(
  'closing an app on $name stops the runner first: $stopsRunner',
  async ({ selected, stopsRunner }) => {
    const events: string[] = [];
    const { host } = lifecycleHost({ events });

    await bind(host, selected).closeApplication({
      appBundleId: 'com.example.app',
      positionals: ['com.example.app'],
      surface: 'app',
      execution: {},
    });

    expect(events).toEqual(
      stopsRunner
        ? [`stop-runner:${selected.id}`, 'close:com.example.app']
        : ['close:com.example.app'],
    );
  },
);

test('close finalization releases the runner before it dismisses close alerts', async () => {
  const events: string[] = [];
  const { host } = lifecycleHost({ events });

  await bind(host, MACOS_DEVICE).finalizeApplicationClose({
    appBundleId: 'com.apple.systempreferences',
    surface: 'app',
    retainRunner: false,
    stateDir: '/tmp',
  });

  expect(events).toEqual(['release-runner:host-macos-local:stop', 'dismiss-alerts']);
});
