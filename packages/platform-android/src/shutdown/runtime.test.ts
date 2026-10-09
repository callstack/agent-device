import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import { canShutdownTarget, createAndroidShutdownRuntime } from './runtime.ts';

const sleep = vi.hoisted(() => vi.fn(async (_ms: number, _signal?: AbortSignal) => {}));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep,
}));

import {
  beginTestImeRestoreWrite,
  registerTestImeRestore,
  SETTINGS_PROVIDER_FLUSH_SETTLE_MS,
  testImeLastRestoreAtPerfMs,
  testImePendingRestoreWrites,
} from '../ime-state.ts';

const run = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
const commands: DeviceShutdownRuntimeDependencies['commands'] = {
  which: async () => 'adb',
  run,
};

// Every expected sleep band is derived from the real window constant (proportional seeds and
// tolerances), so changing SETTINGS_PROVIDER_FLUSH_SETTLE_MS shifts these tests' meaning
// instead of turning them red for a confusing arithmetic reason.
const WINDOW_TOLERANCE_MS = Math.round(SETTINGS_PROVIDER_FLUSH_SETTLE_MS / 10);
// Lower bound for "the window had only just opened" waits.
const nearlyFullWindowFloorMs = SETTINGS_PROVIDER_FLUSH_SETTLE_MS - WINDOW_TOLERANCE_MS;
// The abort/coalescing tests seed a KNOWN elapsed fraction of the window (40%), so the
// expected remainder is a known 60% — a fixed sleep anywhere else fails on the number.
const seededElapsedMs = Math.round(SETTINGS_PROVIDER_FLUSH_SETTLE_MS * 0.4);
const seededRemainderMs = SETTINGS_PROVIDER_FLUSH_SETTLE_MS - seededElapsedMs;

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  sleep.mockReset();
  testImeLastRestoreAtPerfMs.clear();
  testImePendingRestoreWrites.clear();
});

test('an already-stopped emulator succeeds without adb', async () => {
  const runtime = createAndroidShutdownRuntime({ commands });

  await expect(runtime.shutdownTarget(androidDevice({ booted: false }), signal())).resolves.toEqual(
    success(),
  );
  expect(run).not.toHaveBeenCalled();
});

test('an active emulator shuts down through the owning adb command', async () => {
  const device = androidDevice();
  const runtime = createAndroidShutdownRuntime({ commands });

  await expect(runtime.shutdownTarget(device, signal())).resolves.toEqual(success());
  expect(run).toHaveBeenCalledWith(
    {
      executable: 'adb',
      args: ['-s', device.id, 'emu', 'kill'],
      allowFailure: true,
      timeoutMs: 15_000,
    },
    expect.any(AbortSignal),
  );
});

test('only Android emulators are available', () => {
  expect(canShutdownTarget(androidDevice())).toBe(true);
  expect(canShutdownTarget({ ...androidDevice(), kind: 'device' })).toBe(false);
  expect(canShutdownTarget({ ...androidDevice(), platform: 'web' })).toBe(false);
});

// #3318: this runtime is the only executor of `adb emu kill`, so the flush-window hold lives
// here — every kill path (close --shutdown, the standalone shutdown command, any future
// caller) inherits it without knowing about the test IME.
test('a kill waits out a registered test-IME flush window before running adb emu kill', async () => {
  const device = androidDevice();
  testImeLastRestoreAtPerfMs.set(device.id, performance.now());
  // A deferred sleep, not an instantly-resolving one: the point of this hold is that `adb emu
  // kill` does not run WHILE the wait is pending, so the test has to observe the middle of
  // the wait, not just its endpoints.
  const settling = deferred();
  sleep.mockImplementationOnce(() => settling.promise);

  const pendingKill = createAndroidShutdownRuntime({ commands }).shutdownTarget(device, signal());

  // One macrotask boundary: the wait drains (async) in-flight writes before its first sleep.
  await drainMicrotasks();

  // The runtime suspends inside the flush wait before touching adb.
  expect(sleep).toHaveBeenCalledTimes(1);
  // The wait must cover the registered window, not merely be positive: the timestamp was set
  // milliseconds before the kill, so the remaining settle is the whole budget minus that gap.
  // A regression sleeping a fixed unrelated amount would fail here.
  expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(nearlyFullWindowFloorMs);
  expect(run).not.toHaveBeenCalled();

  settling.resolve();
  await expect(pendingKill).resolves.toEqual(success());

  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ args: ['-s', device.id, 'emu', 'kill'] }),
    expect.any(AbortSignal),
  );
  expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([]);
});

// The mark only exists after `ime set` returns and the readback confirms it, but the
// provider's window opens when the device ACCEPTS the write. A kill reading the map
// mid-write sees nothing registered and must not treat that as 'idle'.
test('a kill started while a restore write is in flight waits for it to register', async () => {
  const device = androidDevice();
  // Exactly what restoreAndroidTestImeFor does between issuing `ime set` and registering.
  const closeInFlightWrite = beginTestImeRestoreWrite(device.id);
  const settling = deferred();
  sleep.mockImplementationOnce(() => settling.promise);

  const pendingKill = createAndroidShutdownRuntime({ commands }).shutdownTarget(device, signal());

  // Advance one event-loop turn so the kill REALLY reaches the wait: asserting synchronously
  // after starting the call would pass even if the wait took 'idle' straight through, because
  // the kill would still be suspended at its first microtask. With a full turn drained and the
  // write still in flight and unregistered, a mark-only implementation has already taken
  // 'idle' and called adb — that is the #3318 mid-write kill this test names.
  await drainMicrotasks();

  // Neither the window wait nor adb has started: the in-flight write holds the kill.
  expect(sleep).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();

  // The write lands and registers its window, closing the in-flight entry exactly as the
  // registrar's finally block does.
  registerTestImeRestore(device.id);
  closeInFlightWrite();
  await drainMicrotasks();

  expect(sleep).toHaveBeenCalledTimes(1);
  expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(nearlyFullWindowFloorMs);
  expect(run).not.toHaveBeenCalled();

  settling.resolve();
  await expect(pendingKill).resolves.toEqual(success());
  expect(run).toHaveBeenCalledTimes(1);
  expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([]);
});

test('a pending write that closes with no registered mark releases the kill as idle', async () => {
  // The registrar opens the pending entry for every restore but registers a window only for
  // emulators (the flush hazard is the emulator's SettingsProvider), so a physical-device
  // restore is the production shape of "closed, never registered". The drained wait must fall
  // through to 'idle' — never strand the kill on an entry that will never gain a mark.
  const device = androidDevice();
  const closeInFlightWrite = beginTestImeRestoreWrite(device.id);

  const pendingKill = createAndroidShutdownRuntime({ commands }).shutdownTarget(device, signal());
  expect(run).not.toHaveBeenCalled();

  closeInFlightWrite();

  await expect(pendingKill).resolves.toEqual(success());
  expect(sleep).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledTimes(1);
});

// A restore landing mid-wait must EXTEND this very kill's wait, not just survive for some
// hypothetical next caller — reporting 'covered' on the older mark would fire adb inside the
// newer restore's window, which is #3318 again.
test('a restore landing mid-wait extends the pending kill instead of releasing it', async () => {
  const device = androidDevice();
  // Known elapsed: the original mark is 40% of the window old, so the first wait must derive
  // the remaining 60% — proportional to the constant, not a fixed number.
  testImeLastRestoreAtPerfMs.set(device.id, performance.now() - seededElapsedMs);
  const firstSettling = deferred();
  const secondSettling = deferred();
  sleep
    .mockImplementationOnce(() => firstSettling.promise)
    .mockImplementationOnce(() => secondSettling.promise);

  const pendingKill = createAndroidShutdownRuntime({ commands }).shutdownTarget(device, signal());

  // One macrotask boundary: the wait drains (async) in-flight writes before its first sleep.
  await drainMicrotasks();

  expect(sleep.mock.calls[0]?.[0]).toBeGreaterThan(seededRemainderMs - WINDOW_TOLERANCE_MS);
  expect(sleep.mock.calls[0]?.[0]).toBeLessThanOrEqual(seededRemainderMs);

  // A second confirmed restore lands while this kill sleeps — a newer write, a newer deadline.
  registerTestImeRestore(device.id);
  firstSettling.resolve();
  await drainMicrotasks();

  // The wait re-reads the mark and takes a SECOND sleep covering the newer window, still
  // refusing adb. A one-read-one-sleep implementation returns 'covered' here and kills early.
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(sleep.mock.calls[1]?.[0]).toBeGreaterThanOrEqual(nearlyFullWindowFloorMs);
  expect(sleep.mock.calls[1]?.[0]).toBeLessThanOrEqual(SETTINGS_PROVIDER_FLUSH_SETTLE_MS);
  expect(run).not.toHaveBeenCalled();

  secondSettling.resolve();
  await expect(pendingKill).resolves.toEqual(success());

  expect(run).toHaveBeenCalledTimes(1);
  expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([]);
});

test('a forward host wall-clock jump cannot shorten a registered flush window', async () => {
  // The window is timed on the process monotonic clock, so an NTP/VM-resume step of the wall
  // clock must leave the kill-side remaining wait at the full budget.
  const device = androidDevice();
  testImeLastRestoreAtPerfMs.set(device.id, performance.now());
  const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);

  try {
    await expect(
      createAndroidShutdownRuntime({ commands }).shutdownTarget(device, signal()),
    ).resolves.toEqual(success());
  } finally {
    nowSpy.mockRestore();
  }

  expect(sleep).toHaveBeenCalledTimes(1);
  expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(nearlyFullWindowFloorMs);
});

test('a kill skips the wait entirely when no flush window is open', async () => {
  const device = androidDevice();

  await expect(
    createAndroidShutdownRuntime({ commands }).shutdownTarget(device, signal()),
  ).resolves.toEqual(success());

  expect(sleep).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledTimes(1);
});

test('a kill cancelled inside the flush window never reaches adb emu kill', async () => {
  const device = androidDevice();
  // Known elapsed: the mark is 40% of the window old, so the derived remainder must be the
  // known 60% — not the full budget, not a fixed constant. That makes both waits provably a
  // function of the mark.
  testImeLastRestoreAtPerfMs.set(device.id, performance.now() - seededElapsedMs);
  const controller = new AbortController();
  sleep.mockImplementationOnce((_ms, waitSignal) => {
    controller.abort();
    return waitSignal?.aborted ? Promise.resolve() : new Promise(() => {});
  });

  // Pin the cancellation MECHANISM, not just a rejection: awaitTestImeFlushWindow returns
  // 'aborted' and shutdownAndroidTarget cancels via signal.throwIfAborted(), which throws the
  // signal's exact reason object. An unrelated rejection (a throw inside the flush wait, a
  // normalization bug) must fail this test, not stand in for cancellation.
  const failure = await createAndroidShutdownRuntime({ commands })
    .shutdownTarget(device, controller.signal)
    .catch((error: unknown) => error);
  expect(failure).toBe(controller.signal.reason);
  expect((failure as Error).name).toBe('AbortError');

  expect(run).not.toHaveBeenCalled();
  const firstRemainingMs = sleep.mock.calls[0]?.[0] as number;
  expect(firstRemainingMs).toBeGreaterThan(seededRemainderMs - WINDOW_TOLERANCE_MS);
  expect(firstRemainingMs).toBeLessThanOrEqual(seededRemainderMs);
  // The window stays registered so a retry still waits out the remainder — and the retry
  // re-derives the SAME remainder from the surviving mark: the monotonic-mark property the
  // abort design rests on, pinned by number, not by shape.
  expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([device.id]);

  const retry = await createAndroidShutdownRuntime({ commands }).shutdownTarget(device, signal());

  expect(retry).toEqual(success());
  expect(sleep).toHaveBeenCalledTimes(2);
  const secondRemainingMs = sleep.mock.calls[1]?.[0] as number;
  expect(secondRemainingMs).toBeGreaterThan(seededRemainderMs - WINDOW_TOLERANCE_MS);
  expect(secondRemainingMs).toBeLessThanOrEqual(firstRemainingMs);
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Let the awaited-sleep continuations run: the kill path resumes through promise callbacks, so
// assertions about the middle of the wait need one macrotask boundary, not one microtask tick.
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function success() {
  return { success: true, exitCode: 0, stdout: '', stderr: '' };
}

function androidDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
    ...overrides,
  };
}
