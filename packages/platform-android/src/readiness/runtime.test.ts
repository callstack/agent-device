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
