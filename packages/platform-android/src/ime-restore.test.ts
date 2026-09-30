import { beforeEach, expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
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

async function restoreWith(state: FakeImeDeviceState) {
  return await withAndroidAdbProvider(
    { exec: fakeImeDeviceAdb(state) },
    { serial: DEVICE.id },
    async () => await restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR }),
  );
}

beforeEach(() => {
  resetAndroidTestImeActivationCacheForTests();
});

test('close-time restore puts the previous IME back and clears record and marker', async () => {
  const host = bindAndroidAdbHostStub();
  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  setAndroidTestImeActiveForTests(DEVICE, true);
  const state = stuckDeviceState();

  const result = await restoreWith(state);

  expect(result).toMatchObject({ restored: true, reason: 'ok' });
  expect(state.settings.get('default_input_method')).toBe('com.samsung/.Keyboard');
  expect(state.settings.has('agent_device_ime_helper_previous_ime')).toBe(false);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([]);
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

test("close-time restore undoes a rebind's fallback IME, but not the user's own switch", async () => {
  const host = bindAndroidAdbHostStub();
  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  setAndroidTestImeActiveForTests(DEVICE, true);
  const displaced = stuckDeviceState();
  displaced.settings.set('default_input_method', 'com.android.inputmethod.latin/.LatinIME');
  displaced.settings.set('agent_device_ime_helper_rebind_displaced', '1');

  expect(await restoreWith(displaced)).toMatchObject({ restored: true, reason: 'ok' });
  expect(displaced.settings.get('default_input_method')).toBe('com.samsung/.Keyboard');
  expect(displaced.settings.has('agent_device_ime_helper_previous_ime')).toBe(false);
  expect(displaced.settings.has('agent_device_ime_helper_rebind_displaced')).toBe(false);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([]);

  setAndroidTestImeActiveForTests(DEVICE, true);
  const switched = stuckDeviceState();
  switched.settings.set('default_input_method', 'com.android.inputmethod.latin/.LatinIME');

  expect(await restoreWith(switched)).toMatchObject({ reason: 'helper-not-active' });
  expect(switched.settings.get('default_input_method')).toBe(
    'com.android.inputmethod.latin/.LatinIME',
  );
});

test('devices this process never activated are left alone', async () => {
  bindAndroidAdbHostStub();
  const state = stuckDeviceState();
  const result = await restoreWith(state);
  expect(result).toEqual({ restored: false, reason: 'no-record' });
  expect(state.settings.get('default_input_method')).toBe(HELPER_SERVICE);
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

test('startup recovery restores a stuck orphan through the scoped transport and clears its marker', async () => {
  const host = bindAndroidAdbHostStub();
  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  const state = stuckDeviceState();

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
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([]);
  expect(host.diagnostics).toContainEqual({
    phase: 'android_test_ime_orphan_restored',
    level: 'warn',
  });
});

test("startup recovery undoes a crashed daemon's unconfirmed rebind", async () => {
  const host = bindAndroidAdbHostStub();
  await host.imeRecoveryMarkers.write(STATE_DIR, DEVICE.id);
  const state = stuckDeviceState();
  state.settings.set('default_input_method', 'com.android.inputmethod.latin/.LatinIME');
  state.settings.set('agent_device_ime_helper_rebind_displaced', '1');

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
});
