import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
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
