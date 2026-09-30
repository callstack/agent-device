import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { ensureAndroidReady } from './runtime.ts';

test('cancellation interrupts Android boot polling and terminates the emulator launched by the request', async () => {
  const controller = new AbortController();
  const terminate = vi.fn(async () => {});
  let rejectBootProbe: ((error: unknown) => void) | undefined;
  let discoveries = 0;
  const host = {
    commands: {
      which: async () => 'tool',
      run: vi.fn(
        async (_request, signal) =>
          await new Promise((_, reject) => {
            rejectBootProbe = reject;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    },
    toolchains: { prepare: async () => {} },
    clock: { now: () => 1, sleep: async () => {} },
    deviceReadiness: {
      applePhysical: { ensureConnected: async () => {} },
      appleAutomation: {
        keepHot: () => {},
        markBooted: () => {},
        wasRecentlyObservedBooted: async () => false,
      },
      androidEmulator: {
        discover: async () => {
          discoveries += 1;
          return discoveries === 1 ? [stoppedAvd()] : [runningEmulator()];
        },
        launch: () => 4242,
        terminate,
      },
    },
  } as unknown as PlatformRuntimeHost;

  const pending = ensureAndroidReady(host, stoppedAvd(), { headless: true }, controller.signal);
  await vi.waitFor(() => expect(rejectBootProbe).toBeTypeOf('function'));
  const reason = new Error('cancel boot');
  controller.abort(reason);

  await expect(pending).rejects.toBe(reason);
  expect(terminate).toHaveBeenCalledWith(4242);
});

function timedHost(overrides: { bootCompleted: string; discover: () => DeviceInfo[] }) {
  let now = 1_000;
  const run = vi.fn(async () => ({ stdout: overrides.bootCompleted, stderr: '', exitCode: 0 }));
  const terminate = vi.fn(async () => {});
  const host = {
    commands: { which: async () => 'tool', run },
    toolchains: { prepare: async () => {} },
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    },
    deviceReadiness: {
      androidEmulator: {
        discover: async () => overrides.discover(),
        launch: () => 4242,
        terminate,
      },
    },
  } as unknown as PlatformRuntimeHost;
  return { host, run, terminate, elapsed: () => now - 1_000 };
}

test('a startup deadline bounds the emulator boot wait and expiry reports boot_timeout without killing the emulator', async () => {
  const { host, run, terminate, elapsed } = timedHost({
    bootCompleted: '0',
    discover: () => [runningEmulator()],
  });

  await expect(
    ensureAndroidReady(
      host,
      runningEmulator(),
      { headless: false, deadlineAtMs: 3_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ details: { reason: 'boot_timeout', serial: 'emulator-5554' } });

  expect(elapsed()).toBeLessThan(5_000);
  expect(run).toHaveBeenCalled();
  expect(terminate).not.toHaveBeenCalled();
});

test('a startup deadline also bounds waiting for a launched emulator to appear', async () => {
  const { host, elapsed, terminate } = timedHost({
    bootCompleted: '1',
    discover: () => [stoppedAvd()],
  });

  await expect(
    ensureAndroidReady(
      host,
      stoppedAvd(),
      { headless: true, deadlineAtMs: 3_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ details: { reason: 'boot_timeout' } });
  expect(elapsed()).toBeLessThan(5_000);
  expect(terminate).not.toHaveBeenCalled();
});

test('expiry of a launched emulator that never reports boot_completed leaves it running', async () => {
  let discoveries = 0;
  const { host, terminate } = timedHost({
    bootCompleted: '0',
    discover: () => (++discoveries === 1 ? [stoppedAvd()] : [runningEmulator()]),
  });

  await expect(
    ensureAndroidReady(
      host,
      stoppedAvd(),
      { headless: true, deadlineAtMs: 3_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ details: { reason: 'boot_timeout', serial: 'emulator-5554' } });
  expect(terminate).not.toHaveBeenCalled();
});

test('without a deadline the default 120s boot wait applies', async () => {
  const { host, elapsed } = timedHost({ bootCompleted: '0', discover: () => [runningEmulator()] });

  await expect(
    ensureAndroidReady(host, runningEmulator(), { headless: false }, new AbortController().signal),
  ).rejects.toMatchObject({ details: { reason: 'boot_timeout' } });
  expect(elapsed()).toBeGreaterThanOrEqual(120_000);
});

function stoppedAvd(): DeviceInfo {
  return {
    platform: 'android',
    id: 'Pixel_9',
    name: 'Pixel_9',
    kind: 'emulator',
    target: 'mobile',
    booted: false,
  };
}

function runningEmulator(): DeviceInfo {
  return { ...stoppedAvd(), id: 'emulator-5554' };
}
