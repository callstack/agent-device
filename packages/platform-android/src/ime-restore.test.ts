import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const sleep = vi.hoisted(() => vi.fn(async (_ms: number, _signal?: AbortSignal) => {}));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep,
}));

import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import { withAndroidAdbProvider } from './adb-provider-scope.ts';
import {
  restoreAndroidTestIme,
  restoreOrphanedAndroidTestImeOnDaemonStartup,
} from './ime-restore.ts';
import {
  resetAndroidTestImeActivationCacheForTests,
  setAndroidTestImeActiveForTests,
  SETTINGS_PROVIDER_FLUSH_SETTLE_MS,
  testImeLastRestoreAtPerfMs,
} from './ime-state.ts';
import { fakeImeDeviceAdb, type FakeImeDeviceState } from './ime-device.fixtures.ts';

const DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};
const HELPER_SERVICE = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';
const STATE_DIR = '/state';

function stuckDeviceState(): FakeImeDeviceState {
  return {
    settings: new Map([
      ['default_input_method', HELPER_SERVICE],
      ['agent_device_ime_helper_previous_ime', 'com.samsung/.Keyboard'],
    ]),
  };
}

async function restoreWith(state: FakeImeDeviceState, options: { shutdownTarget?: boolean } = {}) {
  return await withAndroidAdbProvider(
    { exec: fakeImeDeviceAdb(state) },
    { serial: DEVICE.id },
    async () =>
      await restoreAndroidTestIme(DEVICE, {
        stateDir: STATE_DIR,
        shutdownTarget: options.shutdownTarget,
      }),
  );
}

beforeEach(() => {
  resetAndroidTestImeActivationCacheForTests();
  sleep.mockClear();
});

test.each([false, true])('close restores the previous IME with displaced=%s', async (displaced) => {
  const host = bindAndroidAdbHostStub();
  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  setAndroidTestImeActiveForTests(DEVICE, true);
  const state = stuckDeviceState();
  if (displaced) {
    state.settings.set('default_input_method', 'com.android.inputmethod.latin/.LatinIME');
    state.settings.set('agent_device_ime_helper_rebind_displaced', '1');
  }

  const result = await restoreWith(state);

  expect(result).toMatchObject({ restored: true, reason: 'ok' });
  expect(state.settings.get('default_input_method')).toBe('com.samsung/.Keyboard');
  expect(state.settings.has('agent_device_ime_helper_previous_ime')).toBe(false);
  expect(state.settings.has('agent_device_ime_helper_rebind_displaced')).toBe(false);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([]);
});

test('an unreadable rebind record keeps the restore record and the marker for a retry', async () => {
  const host = bindAndroidAdbHostStub();
  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  setAndroidTestImeActiveForTests(DEVICE, true);
  // An unconfirmed rebind left Android on its fallback IME; the close-time record read times out.
  const state = stuckDeviceState();
  state.settings.set('default_input_method', 'com.android.inputmethod.latin/.LatinIME');
  state.settings.set('agent_device_ime_helper_rebind_displaced', '1');
  const deviceAdb = fakeImeDeviceAdb(state);

  const result = await withAndroidAdbProvider(
    {
      exec: async (args) =>
        args[2] === 'get' && args[4] === 'agent_device_ime_helper_rebind_displaced'
          ? { exitCode: 1, stdout: '', stderr: 'timed out' }
          : await deviceAdb(args),
    },
    { serial: DEVICE.id },
    async () => await restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR }),
  );

  expect(result).toMatchObject({ restored: false, reason: 'record-unreadable' });
  expect(state.settings.get('agent_device_ime_helper_previous_ime')).toBe('com.samsung/.Keyboard');
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
});

test('a failed restore keeps the record and the marker for a later retry', async () => {
  const host = bindAndroidAdbHostStub();
  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  setAndroidTestImeActiveForTests(DEVICE, true);
  const state = stuckDeviceState();
  state.imeSetFails = true;

  const result = await restoreWith(state);

  expect(result).toMatchObject({ restored: false, reason: 'set-failed' });
  expect(state.settings.get('agent_device_ime_helper_previous_ime')).toBe('com.samsung/.Keyboard');
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
});

test('devices this process never activated are left alone, marker and all', async () => {
  // The retained marker is the only record an orphaned helper has after a daemon restart; a
  // close that inspected nothing must not consume it.
  const host = bindAndroidAdbHostStub();
  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  const state = stuckDeviceState();
  const result = await restoreWith(state);
  expect(result).toEqual({ restored: false, reason: 'not-activated-here' });
  expect(state.settings.get('default_input_method')).toBe(HELPER_SERVICE);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
});

// #3318: `ime set` is durable only after SettingsProvider's delayed XML flush (AOSP caps it at
// 2 s), so a kill started while that window is open reboots the emulator onto the helper IME.
test('a restore before an emulator shutdown waits out the settings-provider flush window', async () => {
  const host = bindAndroidAdbHostStub();
  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  setAndroidTestImeActiveForTests(DEVICE, true);
  const markerDuringSettle: string[][] = [];
  sleep.mockImplementationOnce(async () => {
    // The marker must survive the settle so a daemon crash mid-window still recovers.
    markerDuringSettle.push([...(host.markerStore.get(STATE_DIR) ?? [])]);
  });
  const signal = new AbortController().signal;

  const result = await withAndroidAdbProvider(
    { exec: fakeImeDeviceAdb(stuckDeviceState()) },
    { serial: DEVICE.id },
    async () =>
      await restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR, shutdownTarget: true, signal }),
  );

  expect(result).toMatchObject({ restored: true, reason: 'ok' });
  expect(sleep).toHaveBeenCalledTimes(1);
  // The window had barely opened at the wait, so the derived remainder is nearly the whole
  // budget; derive both bounds from the constant so a changed window shifts the bound too.
  expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(SETTINGS_PROVIDER_FLUSH_SETTLE_MS * 0.8);
  // A cancelled close never reaches the kill, so the settle stops early with it (see the
  // abort-mid-settle tests below for what an early stop must preserve).
  expect(sleep.mock.calls[0]?.[1]).toBe(signal);
  expect(markerDuringSettle).toEqual([[DEVICE.id]]);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([]);
});

describe('a close cancelled mid-settle', () => {
  // The real sleep resolves early (never rejects) when its signal aborts; the mock has to behave
  // the same or the abort branch is never exercised.
  function abortAwareSleep(signal?: AbortSignal): Promise<void> {
    return signal?.aborted ? Promise.resolve() : new Promise(() => {});
  }

  test('keeps the flush-settle deadline and the pending marker for the next close', async () => {
    const host = bindAndroidAdbHostStub();
    await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
    setAndroidTestImeActiveForTests(DEVICE, true);
    const controller = new AbortController();
    sleep.mockImplementationOnce((_ms, signal) => {
      controller.abort();
      return abortAwareSleep(signal);
    });

    const result = await withAndroidAdbProvider(
      { exec: fakeImeDeviceAdb(stuckDeviceState()) },
      { serial: DEVICE.id },
      async () =>
        await restoreAndroidTestIme(DEVICE, {
          stateDir: STATE_DIR,
          shutdownTarget: true,
          signal: controller.signal,
        }),
    );

    // The keyboard really was restored, but an aborted settle is not a completed settle: the
    // marker survives so a crash-recovery path still covers the unfinished flush window, and the
    // monotonic timestamp keeps the remaining wait derivable for the next kill-bound caller.
    expect(result).toMatchObject({ restored: true, reason: 'ok' });
    expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
    expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([DEVICE.id]);
  });

  test('a second close waits out the remaining window before it may return to the kill', async () => {
    const host = bindAndroidAdbHostStub();
    await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
    setAndroidTestImeActiveForTests(DEVICE, true);
    const first = new AbortController();
    sleep.mockImplementationOnce((_ms, signal) => {
      first.abort();
      return abortAwareSleep(signal);
    });
    const deviceAdb = fakeImeDeviceAdb(stuckDeviceState());
    await withAndroidAdbProvider(
      { exec: deviceAdb },
      { serial: DEVICE.id },
      async () =>
        await restoreAndroidTestIme(DEVICE, {
          stateDir: STATE_DIR,
          shutdownTarget: true,
          signal: first.signal,
        }),
    );

    // The owned flag is gone, so this close inspects nothing — yet the kill it precedes must
    // still wait for the window the aborted close left open, and consuming that deadline is what
    // earns the marker clear (a nothing-inspected close could never clear it on its own).
    sleep.mockClear();
    const second = new AbortController();
    const result = await withAndroidAdbProvider(
      { exec: deviceAdb },
      { serial: DEVICE.id },
      async () =>
        await restoreAndroidTestIme(DEVICE, {
          stateDir: STATE_DIR,
          shutdownTarget: true,
          signal: second.signal,
        }),
    );

    expect(result).toEqual({ restored: false, reason: 'not-activated-here' });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThan(0);
    expect(sleep.mock.calls[0]?.[1]).toBe(second.signal);
    expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([]);
    expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([]);
  });

  test('a restore while a window is open coalesces into one deadline, not two waits', async () => {
    bindAndroidAdbHostStub();
    setAndroidTestImeActiveForTests(DEVICE, true);
    // A window from an earlier aborted close still has most of its budget left when this close's
    // own restore writes again. SettingsState rewrites the whole file, so one wait to the newer
    // write's window persists both writes — the timestamp takes the max, never a second entry.
    // The seeded elapsed (one twentieth of the window) and the expected sleep band are both
    // derived from the window constant, so a changed window keeps this test's meaning.
    const elapsedBeforeCloseMs = Math.round(SETTINGS_PROVIDER_FLUSH_SETTLE_MS / 20);
    testImeLastRestoreAtPerfMs.set(DEVICE.id, performance.now() - elapsedBeforeCloseMs);

    const result = await withAndroidAdbProvider(
      { exec: fakeImeDeviceAdb(stuckDeviceState()) },
      { serial: DEVICE.id },
      async () =>
        await restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR, shutdownTarget: true }),
    );

    expect(result).toMatchObject({ restored: true, reason: 'ok' });
    expect(sleep).toHaveBeenCalledTimes(1);
    // This close's OWN restore re-registers the mark at nearly the full window (the earlier
    // mark was older), so the sleep is derived from the fresh write, not from the seeded one.
    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThan(SETTINGS_PROVIDER_FLUSH_SETTLE_MS * 0.8);
    expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([]);
  });

  test('a second close after the window already elapsed skips the wait', async () => {
    const host = bindAndroidAdbHostStub();
    await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
    // A restore whose whole flush window has already passed (the +1 keeps it elapsed for any
    // constant, instead of the number that happened to be window+1 at writing time).
    testImeLastRestoreAtPerfMs.set(
      DEVICE.id,
      performance.now() - SETTINGS_PROVIDER_FLUSH_SETTLE_MS - 1,
    );

    const result = await withAndroidAdbProvider(
      { exec: fakeImeDeviceAdb(stuckDeviceState()) },
      { serial: DEVICE.id },
      async () =>
        await restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR, shutdownTarget: true }),
    );

    expect(result).toEqual({ restored: false, reason: 'not-activated-here' });
    expect(sleep).not.toHaveBeenCalled();
    expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([]);
    // Load-bearing on this close: it inspected nothing (not-activated-here), and covering the
    // window a confirmed restore had opened is the only thing that earns clearing this marker.
    expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([]);
  });

  test('an ordinary close never waits on a pending window it cannot race', async () => {
    const host = bindAndroidAdbHostStub();
    await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
    testImeLastRestoreAtPerfMs.set(DEVICE.id, performance.now());

    const result = await withAndroidAdbProvider(
      { exec: fakeImeDeviceAdb(stuckDeviceState()) },
      { serial: DEVICE.id },
      async () => await restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR }),
    );

    expect(result).toEqual({ restored: false, reason: 'not-activated-here' });
    expect(sleep).not.toHaveBeenCalled();
    // An ordinary close consumes nothing and inspects nothing: both stay for the next caller.
    expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([DEVICE.id]);
    expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
  });
});

test('an ordinary close restores without any flush wait but registers the window', async () => {
  bindAndroidAdbHostStub();
  setAndroidTestImeActiveForTests(DEVICE, true);

  const result = await withAndroidAdbProvider(
    { exec: fakeImeDeviceAdb(stuckDeviceState()) },
    { serial: DEVICE.id },
    async () => await restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR, shutdownTarget: false }),
  );

  expect(result).toMatchObject({ restored: true, reason: 'ok' });
  expect(sleep).not.toHaveBeenCalled();
  // Registration is what lets a later kill-bound close — including another session's — see the
  // window this restore opened.
  expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([DEVICE.id]);
});

test("a kill-bound close after another close's restore waits out the registered window", async () => {
  // The reviewer's cross-session hole: session A's ordinary close confirmed the restore and
  // dropped ownership; session B's close --shutdown must not kill inside A's flush window even
  // though its own call inspects nothing.
  const host = bindAndroidAdbHostStub();
  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  setAndroidTestImeActiveForTests(DEVICE, true);
  const deviceAdb = fakeImeDeviceAdb(stuckDeviceState());
  await withAndroidAdbProvider(
    { exec: deviceAdb },
    { serial: DEVICE.id },
    async () => await restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR, shutdownTarget: false }),
  );
  // Call one's own contribution, asserted before call two so the two calls' effects stay
  // separable: a confirmed ordinary restore earns the marker clear on the spot, and its only
  // flush-window residue is the registered timestamp. (That the clear is EARNED — an inspected
  // 'ok' with no wait owed — is what this asserts; the clear-not-earned branches live in the
  // cancelled-mid-settle suite, where the first close leaves the marker in place.)
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([]);
  expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([DEVICE.id]);

  sleep.mockClear();
  const result = await withAndroidAdbProvider(
    { exec: deviceAdb },
    { serial: DEVICE.id },
    async () => await restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR, shutdownTarget: true }),
  );

  // Call two's load-bearing contribution: it owns nothing and inspected nothing, yet the kill
  // it precedes waits for the window call one registered, and covering it retires the entry.
  expect(result).toEqual({ restored: false, reason: 'not-activated-here' });
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(sleep.mock.calls[0]?.[0]).toBeGreaterThan(0);
  expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([]);
});

test('a shutdown of a physical device restores without any flush wait', async () => {
  bindAndroidAdbHostStub();
  const device: DeviceInfo = { ...DEVICE, kind: 'device', id: 'R5800ABC1' };
  setAndroidTestImeActiveForTests(device, true);

  const result = await withAndroidAdbProvider(
    { exec: fakeImeDeviceAdb(stuckDeviceState()) },
    { serial: device.id },
    async () => await restoreAndroidTestIme(device, { stateDir: STATE_DIR, shutdownTarget: true }),
  );

  expect(result).toMatchObject({ restored: true, reason: 'ok' });
  expect(sleep).not.toHaveBeenCalled();
});

test('a restore that did not switch the IME back still owes the flush wait it may have written', async () => {
  // Round twelve: a readback mismatch cannot prove the provider never accepted the write, so
  // the issued write owes the kill-bound hold like any other. This path waits ~the full window
  // yet still keeps the record and marker (see the failed-restore tests) — the hold covers the
  // possible half-written flush; the retained evidence covers the retry.
  bindAndroidAdbHostStub();
  setAndroidTestImeActiveForTests(DEVICE, true);
  const state = stuckDeviceState();
  state.imeSetFails = true;

  const result = await restoreWith(state, { shutdownTarget: true });

  expect(result).toMatchObject({ restored: false, reason: 'set-failed' });
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(SETTINGS_PROVIDER_FLUSH_SETTLE_MS * 0.8);
  expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([]);
});

test('startup recovery never scans devices without a pending marker, and retains offline markers', async () => {
  const host = bindAndroidAdbHostStub();
  let listed = 0;
  const listSerials = async () => {
    listed += 1;
    return [];
  };

  await restoreOrphanedAndroidTestImeOnDaemonStartup({ stateDir: STATE_DIR, listSerials });
  expect(listed).toBe(0);

  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  await restoreOrphanedAndroidTestImeOnDaemonStartup({ stateDir: STATE_DIR, listSerials });
  // Offline device: the marker survives for the next reconnect.
  expect(listed).toBe(1);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
});

test.each([false, true])('startup recovers a stuck orphan with displaced=%s', async (displaced) => {
  const host = bindAndroidAdbHostStub();
  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  const state = stuckDeviceState();
  if (displaced) {
    state.settings.set('default_input_method', 'com.android.inputmethod.latin/.LatinIME');
    state.settings.set('agent_device_ime_helper_rebind_displaced', '1');
  }

  await withAndroidAdbProvider(
    { exec: fakeImeDeviceAdb(state) },
    { serial: DEVICE.id },
    async () =>
      await restoreOrphanedAndroidTestImeOnDaemonStartup({
        stateDir: STATE_DIR,
        listSerials: async () => [DEVICE.id],
      }),
  );

  expect(state.settings.get('default_input_method')).toBe('com.samsung/.Keyboard');
  expect(state.settings.has('agent_device_ime_helper_rebind_displaced')).toBe(false);
  expect(state.settings.has('agent_device_ime_helper_previous_ime')).toBe(false);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([]);
  // The startup path writes `ime set` like any other restore, so it owes the same flush window:
  // a later kill-bound path (close --shutdown or the shutdown runtime) must not land inside it.
  // Registration is synchronous — daemon boot never pays a sleep for the window.
  expect([...testImeLastRestoreAtPerfMs.keys()]).toEqual([DEVICE.id]);
  expect(sleep).not.toHaveBeenCalled();
  expect(host.diagnostics).toContainEqual({
    phase: 'android_test_ime_orphan_restored',
    level: 'warn',
  });
});
