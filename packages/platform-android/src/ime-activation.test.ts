import { beforeEach, expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidImeHelperArtifact } from '@agent-device/contracts/android-helper-artifacts';
import { bindAndroidAdbHostStub, type AndroidAdbHostStub } from './adb-host.fixtures.ts';
import { withAndroidAdbProvider } from './adb-provider-scope.ts';
import { activateAndroidTestIme } from './ime-activation.ts';
import { fakeImeDeviceAdb, type FakeImeDeviceState } from './ime-device.fixtures.ts';
import { resetAndroidTestImeActivationCacheForTests, isAndroidTestImeActive } from './ime-state.ts';
import { resetAndroidImeHelperInstallCache } from './ime-helper.ts';

const DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};
const HELPER_SERVICE = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';
const STATE_DIR = '/state';

const ARTIFACT: AndroidImeHelperArtifact = {
  apkPath: '/bundled/helper.apk',
  manifest: {
    name: 'android-ime-helper',
    version: '0.0.0',
    assetName: 'helper.apk',
    sha256: 'f'.repeat(64),
    packageName: 'com.callstack.agentdevice.imehelper',
    versionCode: 1,
    serviceComponent: HELPER_SERVICE,
    broadcastProtocol: 'android-ime-helper-v1',
  },
};

function activationHost(): AndroidAdbHostStub {
  return bindAndroidAdbHostStub({
    ensureHelperInstalled: async (_config, request) => ({
      packageName: request.artifact.manifest.packageName,
      versionCode: request.artifact.manifest.versionCode,
      installed: false,
      reason: 'current',
    }),
  });
}

async function activateWith(state: FakeImeDeviceState) {
  return await withAndroidAdbProvider(
    { exec: fakeImeDeviceAdb(state), imeHelperArtifact: ARTIFACT },
    { serial: DEVICE.id },
    async () => await activateAndroidTestIme(DEVICE, { stateDir: STATE_DIR }),
  );
}

beforeEach(() => {
  resetAndroidTestImeActivationCacheForTests();
  resetAndroidImeHelperInstallCache();
});

test('activation records the restore target and marker, then switches and claims ownership', async () => {
  const host = activationHost();
  const state: FakeImeDeviceState = {
    settings: new Map([['default_input_method', 'com.samsung/.Keyboard']]),
  };

  const result = await activateWith(state);

  expect(result).toMatchObject({ outcome: 'settled', activated: true, alreadyActive: false });
  expect(state.settings.get('agent_device_ime_helper_previous_ime')).toBe('com.samsung/.Keyboard');
  expect(state.settings.get('default_input_method')).toBe(HELPER_SERVICE);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
  expect(isAndroidTestImeActive(DEVICE)).toBe(true);
});

test('a switch that never takes effect rolls back records and claims nothing', async () => {
  const host = activationHost();
  const state: FakeImeDeviceState = {
    settings: new Map([['default_input_method', 'com.samsung/.Keyboard']]),
    imeSetFails: true,
  };

  const result = await activateWith(state);

  expect(result).toMatchObject({ outcome: 'settled', activated: false });
  // Restore record rolled back, marker cleared, no ownership claimed.
  expect(state.settings.has('agent_device_ime_helper_previous_ime')).toBe(false);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([]);
  expect(isAndroidTestImeActive(DEVICE)).toBe(false);
  expect(host.diagnostics).toContainEqual({
    phase: 'android_test_ime_activate_failed',
    level: 'warn',
  });
});

test('an unobtainable helper is an outcome that mutates nothing', async () => {
  const host = bindAndroidAdbHostStub({
    ensureHelperInstalled: async () => {
      throw new Error('device refused the install');
    },
  });
  const state: FakeImeDeviceState = {
    settings: new Map([['default_input_method', 'com.samsung/.Keyboard']]),
  };

  const result = await activateWith(state);

  expect(result).toMatchObject({
    outcome: 'helper-unavailable',
    reason: expect.stringContaining('device refused the install'),
  });
  expect(state.settings.has('agent_device_ime_helper_previous_ime')).toBe(false);
  expect(host.markerStore.get(STATE_DIR)).toBeUndefined();
});
