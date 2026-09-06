import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { platformRuntimeHostFixture } from '../runtime.fixtures.ts';
import { ensureAppleReady } from './runtime.ts';
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

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

test('cold bootstatus receives the remaining shared startup budget rather than a fixed cap', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const host = platformRuntimeHostFixture();
  let booted = false;
  const run = vi.fn<PlatformRuntimeHost['appleTools']['run']>(async (request) => {
    if (request.args.includes('boot')) now.mockReturnValue(11_000);
    if (request.args.includes('bootstatus')) booted = true;
    return {
      stdout: request.args.includes('list')
        ? JSON.stringify({
            devices: { ios: [{ udid: 'sim-1', state: booted ? 'Booted' : 'Shutdown' }] },
          })
        : '',
      stderr: '',
      exitCode: 0,
    };
  });
  try {
    await ensureAppleReady(
      { ...host, appleTools: { ...host.appleTools, run } },
      simulator(),
      new AbortController().signal,
      { deadlineAtMs: 601_000 },
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['bootstatus', 'sim-1', '-b'], timeoutMs: 590_000 }),
      expect.any(AbortSignal),
    );
  } finally {
    now.mockRestore();
  }
});

test('canceled readiness does not settle until its exact simulator shutdown completes', async () => {
  const host = platformRuntimeHostFixture();
  const controller = new AbortController();
  const shutdown = deferred<{ stdout: string; stderr: string; exitCode: number }>();
  const shutdownStarted = deferred<void>();
  const run = vi.fn<PlatformRuntimeHost['appleTools']['run']>(async (request) => {
    if (request.args.includes('list'))
      return {
        stdout: JSON.stringify({ devices: { ios: [{ udid: 'sim-1', state: 'Shutdown' }] } }),
        stderr: '',
        exitCode: 0,
      };
    if (request.args.includes('bootstatus')) {
      controller.abort(new Error('cancel'));
      throw controller.signal.reason;
    }
    if (request.args.includes('shutdown')) {
      shutdownStarted.resolve();
      return await shutdown.promise;
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  let settled = false;
  const pending = ensureAppleReady(
    { ...host, appleTools: { ...host.appleTools, run } },
    simulator(),
    controller.signal,
  ).catch((error) => {
    settled = true;
    throw error;
  });
  const rejection = expect(pending).rejects.toThrow('cancel');
  await shutdownStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(run).toHaveBeenLastCalledWith(
    expect.objectContaining({ args: ['shutdown', 'sim-1'], timeoutMs: 15_000 }),
  );
  shutdown.resolve({ stdout: '', stderr: '', exitCode: 0 });
  await rejection;
});

test('an explicit startup budget waits for initialization even when inventory reports Booted', async () => {
  const host = platformRuntimeHostFixture();
  const run = vi.fn<PlatformRuntimeHost['appleTools']['run']>(async () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
  }));
  await ensureAppleReady(
    {
      ...host,
      appleTools: { ...host.appleTools, run },
      deviceReadiness: {
        ...host.deviceReadiness,
        appleAutomation: {
          ...host.deviceReadiness.appleAutomation,
          wasRecentlyObservedBooted: async () => true,
        },
      },
    },
    simulator(),
    new AbortController().signal,
    { deadlineAtMs: Date.now() + 600_000 },
  );
  expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ args: ['bootstatus', 'sim-1', '-b'] }),
    expect.any(AbortSignal),
  );
});

test('cancellation during the boot command reconciles its potentially started simulator', async () => {
  const host = platformRuntimeHostFixture();
  const controller = new AbortController();
  const run = vi.fn<PlatformRuntimeHost['appleTools']['run']>(async (request) => {
    if (request.args.includes('list'))
      return {
        stdout: JSON.stringify({ devices: { ios: [{ udid: 'sim-1', state: 'Shutdown' }] } }),
        stderr: '',
        exitCode: 0,
      };
    if (request.args.includes('boot')) {
      controller.abort(new Error('cancel boot command'));
      throw controller.signal.reason;
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  await expect(
    ensureAppleReady(
      { ...host, appleTools: { ...host.appleTools, run } },
      simulator(),
      controller.signal,
    ),
  ).rejects.toThrow('cancel boot command');
  expect(run).toHaveBeenLastCalledWith(
    expect.objectContaining({ args: ['shutdown', 'sim-1'], timeoutMs: 15_000 }),
  );
});
