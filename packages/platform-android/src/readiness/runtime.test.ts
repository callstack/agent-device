import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
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

test('reports a bound launch identity once for the discovered serial', async () => {
  let discoveries = 0;
  const { host } = timedHost({
    bootCompleted: '1',
    discover: () => (++discoveries === 1 ? [stoppedAvd()] : [runningEmulator()]),
  });
  const identity = { pid: 4242, startTime: 'start' };
  const bind = vi.fn(async () => identity);
  Object.assign(host.deviceReadiness.androidEmulator, { bindLaunchedEmulator: bind });
  const observer = vi.fn();
  const result = await ensureAndroidReady(
    host,
    stoppedAvd(),
    {
      headless: true,
      onAndroidEmulatorLaunch: observer,
    },
    new AbortController().signal,
  );
  expect(bind).toHaveBeenCalledWith(4242, expect.objectContaining({ id: 'emulator-5554' }));
  expect(observer).toHaveBeenCalledExactlyOnceWith(identity);
  expect(result).toEqual({ ...runningEmulator(), booted: true });
});

test('only a launch this host made reports, including one it could not name', async () => {
  const observer = vi.fn();
  const existing = timedHost({ bootCompleted: '1', discover: () => [runningEmulator()] });
  const bind = vi.fn(async () => undefined);
  Object.assign(existing.host.deviceReadiness.androidEmulator, { bindLaunchedEmulator: bind });
  await ensureAndroidReady(
    existing.host,
    stoppedAvd(),
    { headless: false, onAndroidEmulatorLaunch: observer },
    new AbortController().signal,
  );
  expect(bind).not.toHaveBeenCalled();
  expect(observer).not.toHaveBeenCalled();
  let discoveries = 0;
  const launched = timedHost({
    bootCompleted: '1',
    discover: () => (++discoveries === 1 ? [stoppedAvd()] : [runningEmulator()]),
  });
  Object.assign(launched.host.deviceReadiness.androidEmulator, { bindLaunchedEmulator: bind });
  await ensureAndroidReady(
    launched.host,
    stoppedAvd(),
    { headless: true, onAndroidEmulatorLaunch: observer },
    new AbortController().signal,
  );
  expect(bind).toHaveBeenCalledOnce();
  // The host launched this emulator and could not read its start time: the caller is told a launch
  // happened with no identity, which is what keeps it from mistaking an outside emulator for its own.
  expect(observer).toHaveBeenCalledExactlyOnceWith(undefined);
});

test('abort during binding suppresses the observation and terminates the launched emulator', async () => {
  let discoveries = 0;
  const { host, terminate } = timedHost({
    bootCompleted: '1',
    discover: () => (++discoveries === 1 ? [stoppedAvd()] : [runningEmulator()]),
  });
  const controller = new AbortController();
  const reason = new Error('cancel binding');
  Object.assign(host.deviceReadiness.androidEmulator, {
    bindLaunchedEmulator: async () => {
      controller.abort(reason);
      return { pid: 4242, startTime: 'start' };
    },
  });
  const observer = vi.fn();
  await expect(
    ensureAndroidReady(
      host,
      stoppedAvd(),
      {
        headless: true,
        onAndroidEmulatorLaunch: observer,
      },
      controller.signal,
    ),
  ).rejects.toBe(reason);
  expect(observer).not.toHaveBeenCalled();
  expect(terminate).toHaveBeenCalledWith(4242);
});

test('without a deadline the default 120s boot wait applies', async () => {
  const { host, elapsed } = timedHost({ bootCompleted: '0', discover: () => [runningEmulator()] });

  await expect(
    ensureAndroidReady(host, runningEmulator(), { headless: false }, new AbortController().signal),
  ).rejects.toMatchObject({ details: { reason: 'boot_timeout' } });
  expect(elapsed()).toBeGreaterThanOrEqual(120_000);
});

type ProbeResult = { stdout: string; stderr: string; exitCode: number };

/**
 * A host whose boot probe replays the given results in order, then keeps returning the last one.
 * With `launched`, the first inventory answer is a stopped AVD, so the flow launches one (pid 4242)
 * and every later answer shows it running: that is when the probe results decide.
 */
function probeHost(
  sequence: readonly (ProbeResult | Error)[],
  options: Readonly<{ launched?: boolean }> = {},
) {
  let now = 1_000;
  let discoveries = 0;
  const queue = [...sequence];
  const run = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next as ProbeResult;
  });
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
        discover: async () =>
          options.launched === true && ++discoveries === 1 ? [stoppedAvd()] : [runningEmulator()],
        launch: async () => 4242,
        terminate,
      },
    },
  } as unknown as PlatformRuntimeHost;
  return { host, run, terminate, elapsed: () => now - 1_000 };
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

// A nonzero probe exit is not terminal by itself: typed offline evidence is transient, so the
// poller retries. Without this, a change that makes every nonzero exit terminal would pass.
test('an offline probe exit retries and resolves once the device reports booted', async () => {
  const { host, run } = probeHost([
    { stdout: '', stderr: 'error: device offline', exitCode: 1 },
    { stdout: '1\n', stderr: '', exitCode: 0 },
  ]);

  await expect(
    ensureAndroidReady(
      host,
      runningEmulator(),
      { headless: false, deadlineAtMs: 30_000 },
      new AbortController().signal,
    ),
  ).resolves.toBeDefined();
  expect(run).toHaveBeenCalledTimes(2);
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
    // The readiness deadline was not reached, so the message names the adb layer that timed out.
    message: 'adb timed out after 10000ms',
    details: { adbFailure: 'timeout', reason: 'ANDROID_BOOT_TIMEOUT', serial: 'emulator-5554' },
  });
  expect(run).toHaveBeenCalledTimes(1);
});

test('a probe failure that lands on the readiness deadline reports the spent budget', async () => {
  const { host } = probeHost([]);
  // The probe uses the last of the budget before it fails: the clock passes the deadline.
  Object.assign(host.commands, {
    run: async () => {
      await host.clock.sleep(10_000);
      throw new AppError('COMMAND_FAILED', 'adb timed out after 10000ms', { timeoutMs: 10_000 });
    },
  });

  await expect(
    ensureAndroidReady(
      host,
      runningEmulator(),
      { headless: false, deadlineAtMs: 5_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    message: 'Android device did not finish booting in time',
    details: { reason: 'ANDROID_BOOT_TIMEOUT' },
  });
});

test('a missing tool keeps its code and message when the probe also spent the budget', async () => {
  const { host } = probeHost([]);
  Object.assign(host.commands, {
    run: async () => {
      await host.clock.sleep(10_000);
      throw new AppError('TOOL_MISSING', 'adb not found in PATH');
    },
  });

  await expect(
    ensureAndroidReady(
      host,
      runningEmulator(),
      { headless: false, deadlineAtMs: 5_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'TOOL_MISSING', message: 'adb not found in PATH' });
});

test('an unauthorized device keeps its own message when the probe also spent the budget', async () => {
  const { host } = probeHost([]);
  Object.assign(host.commands, {
    run: async () => {
      await host.clock.sleep(10_000);
      return { stdout: '', stderr: 'error: device unauthorized.', exitCode: 1 };
    },
  });

  const failure = await ensureAndroidReady(
    host,
    runningEmulator(),
    { headless: false, deadlineAtMs: 5_000 },
    new AbortController().signal,
  ).catch((error: unknown) => error);

  expect(failure).toMatchObject({ details: { reason: 'ADB_TRANSPORT_UNAVAILABLE' } });
  expect((failure as Error).message).not.toBe('Android device did not finish booting in time');
});

test('a probe that throws a plain Error fails as a command failure, not UNKNOWN', async () => {
  const { host } = probeHost([new Error('spawn adb EACCES')]);

  await expect(
    ensureAndroidReady(
      host,
      runningEmulator(),
      { headless: false, deadlineAtMs: 30_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', message: 'spawn adb EACCES' });
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

// Each case below decides what happens to an emulator this request launched (pid 4242) when its
// boot fails: a failure with the startup budget still unspent stops it, a spent budget does not,
// and an emulator that was already running is never this request's to stop.
test('a launch the host could not record stops the emulator and keeps the recording failure', async () => {
  let discoveries = 0;
  const { host, terminate } = timedHost({
    bootCompleted: '1',
    discover: () => (++discoveries === 1 ? [stoppedAvd()] : [runningEmulator()]),
  });
  const bindFailure = new AppError('COMMAND_FAILED', 'host refused to record the launch');
  Object.assign(host.deviceReadiness.androidEmulator, {
    bindLaunchedEmulator: async () => {
      throw bindFailure;
    },
  });

  await expect(
    ensureAndroidReady(
      host,
      stoppedAvd(),
      { headless: true, deadlineAtMs: 30_000, onAndroidEmulatorLaunch: vi.fn() },
      new AbortController().signal,
    ),
  ).rejects.toBe(bindFailure);
  expect(terminate).toHaveBeenCalledWith(4242);
});

test('a boot probe that fails inside the budget stops the launched emulator', async () => {
  const { host, terminate, run } = probeHost(
    [{ stdout: '', stderr: 'error: closed', exitCode: 1 }],
    { launched: true },
  );

  await expect(
    ensureAndroidReady(
      host,
      stoppedAvd(),
      { headless: true, deadlineAtMs: 30_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ details: { reason: 'BOOT_COMMAND_FAILED' } });
  expect(run).toHaveBeenCalledTimes(1);
  expect(terminate).toHaveBeenCalledWith(4242);
});

test('discovery that goes wrong after the launch stops the launched emulator', async () => {
  let discoveries = 0;
  const discoveryFailure = new AppError('COMMAND_FAILED', 'adb devices failed');
  const { host, terminate } = timedHost({
    bootCompleted: '1',
    discover: () => {
      discoveries += 1;
      if (discoveries === 1) return [stoppedAvd()];
      if (discoveries === 2) return [runningEmulator()];
      throw discoveryFailure;
    },
  });

  await expect(
    ensureAndroidReady(
      host,
      stoppedAvd(),
      { headless: true, deadlineAtMs: 30_000 },
      new AbortController().signal,
    ),
  ).rejects.toBe(discoveryFailure);
  expect(terminate).toHaveBeenCalledWith(4242);
});

test('a boot probe that spends the startup budget leaves the launched emulator booting', async () => {
  const { host, terminate } = probeHost([], { launched: true });
  // The probe uses the last of the budget before it fails: the clock passes the deadline.
  Object.assign(host.commands, {
    run: async () => {
      await host.clock.sleep(10_000);
      throw new AppError('COMMAND_FAILED', 'adb timed out after 10000ms', { timeoutMs: 10_000 });
    },
  });

  const failure = await ensureAndroidReady(
    host,
    stoppedAvd(),
    { headless: true, deadlineAtMs: 5_000 },
    new AbortController().signal,
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({ details: { reason: 'ANDROID_BOOT_TIMEOUT' } });
  // Keeping the launch is this boot wait's own knowledge, never a `details` field on the wire.
  expect(
    (failure as { details?: Record<string, unknown> }).details?.bootBudgetSpent,
  ).toBeUndefined();
  expect(terminate).not.toHaveBeenCalled();
});

test('a step that fails after the boot is done stops the launched emulator past the deadline', async () => {
  let discoveries = 0;
  const lateFailure = new AppError('COMMAND_FAILED', 'adb devices failed');
  const { host, terminate } = timedHost({
    bootCompleted: '1',
    discover: () => {
      discoveries += 1;
      if (discoveries === 1) return [stoppedAvd()];
      // The boot is over; this refresh is the step after it, and it fails once the clock is past
      // the startup deadline. A spent budget keeps an emulator that is still coming up, and this one
      // is already up, so the launch is this request's to stop.
      if (discoveries === 2) {
        host.clock.sleep(60_000);
        throw lateFailure;
      }
      return [runningEmulator()];
    },
  });

  await expect(
    ensureAndroidReady(
      host,
      stoppedAvd(),
      { headless: true, deadlineAtMs: 30_000 },
      new AbortController().signal,
    ),
  ).rejects.toBe(lateFailure);
  expect(terminate).toHaveBeenCalledWith(4242);
});

test('an emulator that was already running is not stopped when its boot probe fails', async () => {
  const { host, terminate } = probeHost([{ stdout: '', stderr: 'error: closed', exitCode: 1 }]);

  await expect(
    ensureAndroidReady(
      host,
      runningEmulator(),
      { headless: false, deadlineAtMs: 30_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ details: { reason: 'BOOT_COMMAND_FAILED' } });
  expect(terminate).not.toHaveBeenCalled();
});

// #4867: a second `open` can bind to the emulator this one is still booting. Whoever owns it then,
// that open's failed boot must not stop it.
test('a boot that fails while another owner holds the launched emulator stops nothing', async () => {
  const { host, terminate } = probeHost([{ stdout: '', stderr: 'error: closed', exitCode: 1 }], {
    launched: true,
  });
  const heldByOther = vi.fn(async () => true);

  await expect(
    ensureAndroidReady(
      host,
      stoppedAvd(),
      { headless: true, deadlineAtMs: 30_000, isAndroidEmulatorHeldByOther: heldByOther },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ details: { reason: 'BOOT_COMMAND_FAILED' } });
  // The ownership question is asked for the emulator this boot discovered, not the AVD it started from.
  expect(heldByOther).toHaveBeenCalledWith(expect.objectContaining({ id: 'emulator-5554' }));
  expect(terminate).not.toHaveBeenCalled();
});

test('a boot that fails while no owner holds the launched emulator still stops it', async () => {
  const { host, terminate } = probeHost([{ stdout: '', stderr: 'error: closed', exitCode: 1 }], {
    launched: true,
  });
  const heldByOther = vi.fn(async () => false);

  await expect(
    ensureAndroidReady(
      host,
      stoppedAvd(),
      { headless: true, deadlineAtMs: 30_000, isAndroidEmulatorHeldByOther: heldByOther },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ details: { reason: 'BOOT_COMMAND_FAILED' } });
  expect(terminate).toHaveBeenCalledWith(4242);
});

test('a boot whose discovery fails before the deadline asks about the AVD this request selected', async () => {
  let discoveries = 0;
  const discoveryFailure = new AppError('COMMAND_FAILED', 'adb devices failed');
  const { host, terminate } = timedHost({
    bootCompleted: '1',
    discover: () => {
      discoveries += 1;
      if (discoveries === 2) throw discoveryFailure;
      return [stoppedAvd()];
    },
  });
  const heldByOther = vi.fn(async () => true);

  await expect(
    ensureAndroidReady(
      host,
      stoppedAvd(),
      { headless: true, deadlineAtMs: 30_000, isAndroidEmulatorHeldByOther: heldByOther },
      new AbortController().signal,
    ),
  ).rejects.toBe(discoveryFailure);
  // The boot never got a serial, so the ownership question addresses the device it did have.
  expect(heldByOther).toHaveBeenCalledWith(expect.objectContaining({ id: 'Pixel_9' }));
  expect(terminate).not.toHaveBeenCalled();
});

test('a boot whose owner question cannot be answered keeps the launched emulator running', async () => {
  const { host, terminate } = probeHost([{ stdout: '', stderr: 'error: closed', exitCode: 1 }], {
    launched: true,
  });
  const heldByOther = vi.fn(async () => {
    throw new Error('claim state unreadable');
  });

  await expect(
    ensureAndroidReady(
      host,
      stoppedAvd(),
      { headless: true, deadlineAtMs: 30_000, isAndroidEmulatorHeldByOther: heldByOther },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ details: { reason: 'BOOT_COMMAND_FAILED' } });
  // Nobody could say who owns the emulator, so nothing is signaled to it (#4764 rule).
  expect(terminate).not.toHaveBeenCalled();
});

test('a host that refuses the stop still reports the boot failure and records the refusal', async () => {
  await withDiagnosticsScope({ command: 'open' }, async () => {
    const { host, terminate } = probeHost([{ stdout: '', stderr: 'error: closed', exitCode: 1 }], {
      launched: true,
    });
    terminate.mockRejectedValue(new Error('pid 4242 is not this host'));

    await expect(
      ensureAndroidReady(
        host,
        stoppedAvd(),
        { headless: true, deadlineAtMs: 30_000 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ details: { reason: 'BOOT_COMMAND_FAILED' } });
    expect(countDiagnosticEventsByPhase(['android_emulator_launch_terminate_failed'])).toBe(1);
  });
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
