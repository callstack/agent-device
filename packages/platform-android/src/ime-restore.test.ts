import { beforeEach, expect, test, vi } from 'vitest';
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

test('devices this process never activated are left alone', async () => {
  bindAndroidAdbHostStub();
  const state = stuckDeviceState();
  const result = await restoreWith(state);
  expect(result).toEqual({ restored: false, reason: 'no-record' });
  expect(state.settings.get('default_input_method')).toBe(HELPER_SERVICE);
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
  expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(2_000);
  // A cancelled close never reaches the kill, so the settle must stop early with it.
  expect(sleep.mock.calls[0]?.[1]).toBe(signal);
  expect(markerDuringSettle).toEqual([[DEVICE.id]]);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([]);
});

test('an ordinary close restores without any flush wait', async () => {
  bindAndroidAdbHostStub();
  setAndroidTestImeActiveForTests(DEVICE, true);

  const result = await withAndroidAdbProvider(
    { exec: fakeImeDeviceAdb(stuckDeviceState()) },
    { serial: DEVICE.id },
    async () => await restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR, shutdownTarget: false }),
  );

  expect(result).toMatchObject({ restored: true, reason: 'ok' });
  expect(sleep).not.toHaveBeenCalled();
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

test('a restore that did not switch the IME back skips the flush wait', async () => {
  bindAndroidAdbHostStub();
  setAndroidTestImeActiveForTests(DEVICE, true);
  const state = stuckDeviceState();
  state.imeSetFails = true;

  const result = await restoreWith(state, { shutdownTarget: true });

  expect(result).toMatchObject({ restored: false, reason: 'set-failed' });
  expect(sleep).not.toHaveBeenCalled();
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
  expect(host.diagnostics).toContainEqual({
    phase: 'android_test_ime_orphan_restored',
    level: 'warn',
  });
});
