import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
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
        launch: async () => 4242,
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
  const launch = vi.fn(async () => 4242);
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
        launch,
        terminate,
      },
    },
  } as unknown as PlatformRuntimeHost;
  return { host, run, launch, terminate, elapsed: () => now - 1_000 };
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

test('a launched emulator gets the remaining startup budget for its window watcher', async () => {
  let discoveries = 0;
  const { host, launch } = timedHost({
    bootCompleted: '1',
    discover: () => (++discoveries === 1 ? [stoppedAvd()] : [runningEmulator()]),
  });

  await ensureAndroidReady(
    host,
    stoppedAvd(),
    { headless: false, deadlineAtMs: 31_000 },
    new AbortController().signal,
  );

  expect(launch).toHaveBeenCalledWith('Pixel_9', false, 30_000);
});

test('without a deadline the default 120s boot wait applies', async () => {
  const { host, elapsed } = timedHost({ bootCompleted: '0', discover: () => [runningEmulator()] });

  await expect(
    ensureAndroidReady(host, runningEmulator(), { headless: false }, new AbortController().signal),
  ).rejects.toMatchObject({ details: { reason: 'boot_timeout' } });
  expect(elapsed()).toBeGreaterThanOrEqual(120_000);
});

type ProbeResult = { stdout: string; stderr: string; exitCode: number };

/** A host whose boot probe replays the given results in order, then keeps returning the last one. */
function probeHost(sequence: readonly (ProbeResult | Error)[]) {
  let now = 1_000;
  const queue = [...sequence];
  const run = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next as ProbeResult;
  });
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
        discover: async () => [runningEmulator()],
        launch: async () => 4242,
        terminate: async () => {},
      },
    },
  } as unknown as PlatformRuntimeHost;
  return { host, run, elapsed: () => now - 1_000 };
}

const BOOTED_PROBE: ProbeResult = { stdout: '1\n', stderr: '', exitCode: 0 };

test('identical probe failure text retries on transient typed evidence and fails promptly on terminal typed evidence', async () => {
  const text = 'adb shell getprop sys.boot_completed failed';
  const typed = { adbFailure: 'device_not_found', retriable: true };
  const input = { headless: false, deadlineAtMs: 30_000 };

  const transient = probeHost([new AppError('COMMAND_FAILED', text, typed), BOOTED_PROBE]);
  await expect(
    ensureAndroidReady(transient.host, runningEmulator(), input, new AbortController().signal),
  ).resolves.toMatchObject({ booted: true });
  expect(transient.run).toHaveBeenCalledTimes(2);

  const terminal = probeHost([
    new AppError('COMMAND_FAILED', text, { ...typed, adbHostRefusal: true }),
    BOOTED_PROBE,
  ]);
  await expect(
    ensureAndroidReady(terminal.host, runningEmulator(), input, new AbortController().signal),
  ).rejects.toMatchObject({
    message: text,
    details: { adbHostRefusal: true, reason: 'ADB_TRANSPORT_UNAVAILABLE', serial: 'emulator-5554' },
  });
  expect(terminal.run).toHaveBeenCalledTimes(1);
  expect(terminal.elapsed()).toBe(0);
});

test.each(['error: device unauthorized', 'device unauthorized'])(
  'a terminal typed unauthorized observation (%s) fails after one poll, not at the deadline',
  async (stderr) => {
    const { host, run } = probeHost([{ stdout: '', stderr, exitCode: 1 }]);

    await expect(
      ensureAndroidReady(
        host,
        runningEmulator(),
        { headless: false, deadlineAtMs: 30_000 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        adbFailure: 'device_unauthorized',
        reason: 'ADB_TRANSPORT_UNAVAILABLE',
        serial: 'emulator-5554',
      },
    });
    expect(run).toHaveBeenCalledTimes(1);
  },
);

test('a retriable device-not-found host refusal stays terminal', async () => {
  const { host, run } = probeHost([
    { stdout: '', stderr: "error: device 'emulator-5554' not found", exitCode: 1 },
  ]);

  await expect(
    ensureAndroidReady(
      host,
      runningEmulator(),
      { headless: false, deadlineAtMs: 30_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    details: {
      adbFailure: 'device_not_found',
      retriable: true,
      adbHostRefusal: true,
      reason: 'ADB_TRANSPORT_UNAVAILABLE',
    },
  });
  expect(run).toHaveBeenCalledTimes(1);
});

test('a terminal probe failure keeps the original cause', async () => {
  const cause = new Error('spawn adb ENOENT');
  const { host } = probeHost([new AppError('TOOL_MISSING', 'adb not found in PATH', {}, cause)]);

  await expect(
    ensureAndroidReady(
      host,
      runningEmulator(),
      { headless: false, deadlineAtMs: 30_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'TOOL_MISSING', cause });
});

test('an unclassified nonzero probe exit stays terminal instead of becoming boot_timeout', async () => {
  const { host, run } = probeHost([{ stdout: '', stderr: 'error: closed', exitCode: 1 }]);

  await expect(
    ensureAndroidReady(
      host,
      runningEmulator(),
      { headless: false, deadlineAtMs: 30_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    details: { reason: 'BOOT_COMMAND_FAILED', serial: 'emulator-5554' },
  });
  expect(run).toHaveBeenCalledTimes(1);
});

test('offline wording on stdout carries no typed evidence and stays terminal', async () => {
  const { host, run } = probeHost([{ stdout: 'device offline', stderr: '', exitCode: 1 }]);

  const failure = await ensureAndroidReady(
    host,
    runningEmulator(),
    { headless: false, deadlineAtMs: 30_000 },
    new AbortController().signal,
  ).then(
    () => {
      throw new Error('expected readiness to fail');
    },
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ details: { reason: 'BOOT_COMMAND_FAILED' } });
  expect((failure as { details?: Record<string, unknown> }).details?.adbFailure).toBeUndefined();
  expect(run).toHaveBeenCalledTimes(1);
});

test('a probe-level timeout is a typed ANDROID_BOOT_TIMEOUT terminal, not a raw exec timeout', async () => {
  const { host, run } = probeHost([
    new AppError('COMMAND_FAILED', 'adb timed out after 10000ms', { timeoutMs: 10_000 }),
  ]);

  await expect(
    ensureAndroidReady(
      host,
      runningEmulator(),
      { headless: false, deadlineAtMs: 30_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    details: { adbFailure: 'timeout', reason: 'ANDROID_BOOT_TIMEOUT', serial: 'emulator-5554' },
  });
  expect(run).toHaveBeenCalledTimes(1);
});

test('a thrown offline wording without typed details does not retry, proving text cannot drive the verdict', async () => {
  const { host, run } = probeHost([new AppError('COMMAND_FAILED', 'device offline')]);

  await expect(
    ensureAndroidReady(
      host,
      runningEmulator(),
      { headless: false, deadlineAtMs: 30_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ details: { reason: 'BOOT_COMMAND_FAILED' } });
  expect(run).toHaveBeenCalledTimes(1);
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
