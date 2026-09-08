import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { platformRuntimeHostFixture } from '../runtime.fixtures.ts';
import { ensureAppleReady } from './runtime.ts';

test('recent native boot observation avoids a duplicate simulator listing', async () => {
  const run = vi.fn(async () => ({
    stdout: JSON.stringify({ devices: { ios: [{ udid: 'sim-1', state: 'Booted' }] } }),
    stderr: '',
    exitCode: 0,
  }));
  const markBooted = vi.fn();
  const host = platformRuntimeHostFixture();

  await ensureAppleReady(
    {
      ...host,
      appleTools: { ...host.appleTools, run },
      deviceReadiness: {
        ...host.deviceReadiness,
        appleAutomation: {
          keepHot: vi.fn(),
          markBooted,
          wasRecentlyObservedBooted: vi.fn(async () => true),
        },
      },
    },
    simulator({ booted: true }),
    new AbortController().signal,
  );

  expect(run).not.toHaveBeenCalled();
  expect(markBooted).toHaveBeenCalledOnce();
});

test('plain device boot state does not bypass native readiness observation', async () => {
  const run = vi.fn(async () => ({
    stdout: JSON.stringify({ devices: { ios: [{ udid: 'sim-1', state: 'Booted' }] } }),
    stderr: '',
    exitCode: 0,
  }));
  const host = platformRuntimeHostFixture();

  await ensureAppleReady(
    {
      ...host,
      appleTools: { ...host.appleTools, run },
      deviceReadiness: {
        ...host.deviceReadiness,
        appleAutomation: {
          keepHot: vi.fn(),
          markBooted: vi.fn(),
          wasRecentlyObservedBooted: vi.fn(async () => false),
        },
      },
    },
    simulator({ booted: true }),
    new AbortController().signal,
  );

  expect(run).toHaveBeenCalledOnce();
});

test('failed recent-observation lookup falls back to native simulator listing', async () => {
  const run = vi.fn(async () => ({
    stdout: JSON.stringify({ devices: { ios: [{ udid: 'sim-1', state: 'Booted' }] } }),
    stderr: '',
    exitCode: 0,
  }));
  const host = platformRuntimeHostFixture();

  await ensureAppleReady(
    {
      ...host,
      appleTools: { ...host.appleTools, run },
      deviceReadiness: {
        ...host.deviceReadiness,
        appleAutomation: {
          ...host.deviceReadiness.appleAutomation,
          wasRecentlyObservedBooted: vi.fn(async () => {
            throw new Error('memo unavailable');
          }),
        },
      },
    },
    simulator({ booted: true }),
    new AbortController().signal,
  );

  expect(run).toHaveBeenCalledOnce();
});

test('cancellation interrupts simulator bootstatus and schedules cleanup for the request boot', async () => {
  const controller = new AbortController();
  const keepHot = vi.fn();
  const calls: string[][] = [];
  let rejectBootstatus: ((error: unknown) => void) | undefined;
  const run: PlatformRuntimeHost['appleTools']['run'] = vi.fn(async (request, signal) => {
    calls.push([...request.args]);
    if (request.args.includes('list')) {
      return {
        stdout: JSON.stringify({ devices: { ios: [{ udid: 'sim-1', state: 'Shutdown' }] } }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (request.args.includes('bootstatus')) {
      return await new Promise<never>((_, reject) => {
        rejectBootstatus = reject;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const host = {
    ...platformRuntimeHostFixture(),
    appleTools: {
      isXcrunAvailable: async () => true,
      run,
    },
    deviceReadiness: {
      ...platformRuntimeHostFixture().deviceReadiness,
      appleAutomation: {
        keepHot,
        markBooted: vi.fn(),
        wasRecentlyObservedBooted: vi.fn(async () => false),
      },
    },
  } satisfies PlatformRuntimeHost;

  const pending = ensureAppleReady(host, simulator(), controller.signal);
  await vi.waitFor(() => expect(rejectBootstatus).toBeTypeOf('function'));
  const reason = new Error('cancel boot');
  controller.abort(reason);

  await expect(pending).rejects.toBe(reason);
  await vi.waitFor(() => expect(calls.some((args) => args.includes('shutdown'))).toBe(true));
  expect(keepHot).toHaveBeenCalledOnce();
});

test('a startup deadline is one budget shared by simctl boot and bootstatus, and its expiry reports boot_timeout while the Simulator keeps booting', async () => {
  vi.useFakeTimers();
  try {
    const startedAtMs = 1_000_000;
    vi.setSystemTime(startedAtMs);
    const { host, calls } = coldSimulatorHost({
      onBoot: () => vi.setSystemTime(startedAtMs + 2_000),
      onBootstatus: () => {
        vi.setSystemTime(startedAtMs + 30_000);
        throw new Error('xcrun timed out after 28000ms');
      },
    });

    await expect(
      ensureAppleReady(host, simulator(), new AbortController().signal, {
        deadlineAtMs: startedAtMs + 30_000,
      }),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'boot_timeout', deviceId: 'sim-1' },
    });

    expect(calls.find((call) => call.args.includes('boot'))?.timeoutMs).toBe(30_000);
    expect(calls.find((call) => call.args.includes('bootstatus'))?.timeoutMs).toBe(28_000);
    // A deadline is not a cancellation: the boot it started is left to finish.
    expect(calls.some((call) => call.args.includes('shutdown'))).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('a boot confirmed only after the deadline is a boot_timeout, and the confirming listing runs inside the budget', async () => {
  vi.useFakeTimers();
  try {
    const startedAtMs = 1_000_000;
    vi.setSystemTime(startedAtMs);
    const { host, calls } = coldSimulatorHost({
      onBoot: () => vi.setSystemTime(startedAtMs + 2_000),
      onBootstatus: () => vi.setSystemTime(startedAtMs + 22_000),
      onBootedList: () => vi.setSystemTime(startedAtMs + 31_000),
    });

    await expect(
      ensureAppleReady(host, simulator(), new AbortController().signal, {
        deadlineAtMs: startedAtMs + 30_000,
      }),
    ).rejects.toMatchObject({ details: { reason: 'boot_timeout', deviceId: 'sim-1' } });

    const listings = calls.filter((call) => call.args.includes('list'));
    expect(listings.at(-1)?.timeoutMs).toBe(8_000);
    expect(calls.some((call) => call.args.includes('shutdown'))).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('without a startup deadline the boot wait keeps its default budget', async () => {
  const { host, calls } = coldSimulatorHost({});

  await ensureAppleReady(host, simulator(), new AbortController().signal);

  expect(calls.find((call) => call.args.includes('bootstatus'))?.timeoutMs).toBe(120_000);
});

test('physical readiness forwards the request signal to the focused host port', async () => {
  const host = platformRuntimeHostFixture();
  const ensureConnected = vi.fn(async () => {});
  const controller = new AbortController();
  await ensureAppleReady(
    {
      ...host,
      deviceReadiness: { ...host.deviceReadiness, applePhysical: { ensureConnected } },
    },
    simulator({ kind: 'device' }),
    controller.signal,
  );
  expect(ensureConnected).toHaveBeenCalledWith(expect.anything(), controller.signal);
});

/** A Shutdown Simulator whose boot, bootstatus, and post-boot listing run the given hooks first. */
function coldSimulatorHost(hooks: {
  onBoot?: () => void;
  onBootstatus?: () => void;
  onBootedList?: () => void;
}) {
  const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  let state = 'Shutdown';
  const run: PlatformRuntimeHost['appleTools']['run'] = vi.fn(async (request) => {
    calls.push({ args: [...request.args], timeoutMs: request.timeoutMs });
    if (request.args.includes('list')) {
      if (state === 'Booted') hooks.onBootedList?.();
      return {
        stdout: JSON.stringify({ devices: { ios: [{ udid: 'sim-1', state }] } }),
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
  const base = platformRuntimeHostFixture();
  const host = {
    ...base,
    appleTools: { isXcrunAvailable: async () => true, run },
    deviceReadiness: {
      ...base.deviceReadiness,
      appleAutomation: {
        keepHot: vi.fn(),
        markBooted: vi.fn(),
        wasRecentlyObservedBooted: vi.fn(async () => false),
      },
    },
  } satisfies PlatformRuntimeHost;
  return { host, calls };
}

function simulator(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
    target: 'mobile',
    booted: false,
    ...overrides,
  };
}
