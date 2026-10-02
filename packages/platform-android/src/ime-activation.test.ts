import { beforeEach, expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidImeHelperArtifact } from './helper-artifacts.ts';
import type { AndroidAdbExecutor } from './adb-transport.ts';
import { bindAndroidAdbHostStub, type AndroidAdbHostStub } from './adb-host.fixtures.ts';
import { withAndroidAdbProvider } from './adb-provider-scope.ts';
import { activateAndroidTestIme } from './ime-activation.ts';
import { fakeImeDeviceAdb, type FakeImeDeviceState } from './ime-device.fixtures.ts';
import {
  getAndroidTestImeOwnership,
  isAndroidTestImeActive,
  resetAndroidTestImeActivationCacheForTests,
} from './ime-state.ts';
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

test('an unobtainable helper carries its curated advice into the outcome', async () => {
  bindAndroidAdbHostStub({
    ensureHelperInstalled: async () => {
      throw new AppError('COMMAND_FAILED', 'adb timed out after 30000ms', {
        timeoutMs: 30_000,
        hint: 'check the device screen for a pending install confirmation',
      });
    },
  });
  const state: FakeImeDeviceState = {
    settings: new Map([['default_input_method', 'com.samsung/.Keyboard']]),
  };

  const result = await activateWith(state);

  // The caller logs `reason` plus `hint`; dropping the hint would hide the install-confirmation
  // advice that the helper install seam attached.
  expect(result).toMatchObject({
    outcome: 'helper-unavailable',
    reason: 'adb timed out after 30000ms',
    hint: 'check the device screen for a pending install confirmation',
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
  // No curated advice, no `hint`: the caller's log must not gain per-code boilerplate.
  expect(result).not.toHaveProperty('hint');
  expect(state.settings.has('agent_device_ime_helper_previous_ime')).toBe(false);
  expect(host.markerStore.get(STATE_DIR)).toBeUndefined();
});

async function withDeviceAdb<T>(exec: AndroidAdbExecutor, task: () => Promise<T>): Promise<T> {
  return await withAndroidAdbProvider(
    { exec, imeHelperArtifact: ARTIFACT },
    { serial: DEVICE.id },
    task,
  );
}

const REBIND_DISPLACED = 'agent_device_ime_helper_rebind_displaced';

test('activation does not switch while the rebind record cannot be read', async () => {
  activationHost();
  const state: FakeImeDeviceState = {
    settings: new Map([
      ['default_input_method', 'com.android.inputmethod.latin/.LatinIME'],
      ['agent_device_ime_helper_previous_ime', 'com.samsung/.Keyboard'],
      [REBIND_DISPLACED, '1'],
    ]),
  };
  const deviceAdb = fakeImeDeviceAdb(state);

  const result = await withDeviceAdb(
    async (args) =>
      args[1] === 'settings' && args[2] === 'get' && args[4] === REBIND_DISPLACED
        ? { exitCode: 1, stdout: '', stderr: 'timed out' }
        : await deviceAdb(args),
    async () => await activateAndroidTestIme(DEVICE, { stateDir: STATE_DIR }),
  );

  expect(result).toMatchObject({ activated: false, persistFailed: true });
  expect(state.settings.get('agent_device_ime_helper_previous_ime')).toBe('com.samsung/.Keyboard');
  expect(state.settings.get('default_input_method')).toBe(
    'com.android.inputmethod.latin/.LatinIME',
  );
  expect(isAndroidTestImeActive(DEVICE)).toBe(false);
});

test('an idempotent activation keeps a rebind the device record marks as unconfirmed', async () => {
  activationHost();
  const state: FakeImeDeviceState = {
    settings: new Map([['default_input_method', 'com.samsung/.Keyboard']]),
  };
  await activateWith(state);
  state.settings.set(REBIND_DISPLACED, '1');
  resetAndroidTestImeActivationCacheForTests();

  const result = await activateWith(state);

  expect(result).toMatchObject({ alreadyActive: true });
  expect(getAndroidTestImeOwnership(DEVICE)?.rebindUnconfirmed).toBe(true);
});

test('a confirmed activation clears a rebind record left without a restore record', async () => {
  activationHost();
  const state: FakeImeDeviceState = {
    settings: new Map([
      ['default_input_method', 'com.samsung/.Keyboard'],
      [REBIND_DISPLACED, '1'],
    ]),
  };

  const result = await activateWith(state);

  expect(result).toMatchObject({ activated: true, previousIme: 'com.samsung/.Keyboard' });
  expect(state.settings.has(REBIND_DISPLACED)).toBe(false);
  expect(getAndroidTestImeOwnership(DEVICE)?.rebindUnconfirmed).toBe(false);
});

test('activation claims ownership before settling an earlier rebind record', async () => {
  activationHost();
  const state: FakeImeDeviceState = {
    settings: new Map([
      ['default_input_method', 'com.android.inputmethod.latin/.LatinIME'],
      ['agent_device_ime_helper_previous_ime', 'com.samsung/.Keyboard'],
      [REBIND_DISPLACED, '1'],
    ]),
  };
  const deviceAdb = fakeImeDeviceAdb(state);

  const activation = withDeviceAdb(
    async (args) => {
      if (args[2] === 'delete' && args[4] === REBIND_DISPLACED) throw new Error('adb timed out');
      return await deviceAdb(args);
    },
    async () => await activateAndroidTestIme(DEVICE, { stateDir: STATE_DIR }),
  );

  await expect(activation).rejects.toThrow('adb timed out');
  expect(state.settings.get('default_input_method')).toBe(HELPER_SERVICE);
  expect(getAndroidTestImeOwnership(DEVICE)?.rebindUnconfirmed).toBe(true);
});
