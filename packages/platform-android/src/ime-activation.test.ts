import { beforeEach, expect, test } from 'vitest';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidImeHelperArtifact } from './helper-artifacts.ts';
import { bindAndroidAdbHostStub, type AndroidAdbHostStub } from './adb-host.fixtures.ts';
import { withAndroidAdbProvider } from './adb-provider-scope.ts';
import { activateAndroidTestIme, rebindAndroidTestIme } from './ime-activation.ts';
import { restoreAndroidTestIme } from './ime-restore.ts';
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

async function rebindWith(state: FakeImeDeviceState) {
  return await withAndroidAdbProvider(
    { exec: fakeImeDeviceAdb(state), imeHelperArtifact: ARTIFACT },
    { serial: DEVICE.id },
    async () => await rebindAndroidTestIme(DEVICE),
  );
}

test('a rebind that leaves the helper selected confirms it and changes no records', async () => {
  const host = activationHost();
  const state: FakeImeDeviceState = {
    settings: new Map([['default_input_method', 'com.samsung/.Keyboard']]),
  };
  await activateWith(state);

  expect(await rebindWith(state)).toBe(true);
  expect(state.settings.get('agent_device_ime_helper_previous_ime')).toBe('com.samsung/.Keyboard');
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
  expect(isAndroidTestImeActive(DEVICE)).toBe(true);
});

test("a rebind that displaces the helper keeps ownership and the user's IME as restore target", async () => {
  const host = activationHost();
  const state: FakeImeDeviceState = {
    settings: new Map([['default_input_method', 'com.samsung/.Keyboard']]),
  };
  await activateWith(state);
  state.imeDisableFallback = 'com.android.inputmethod.latin/.LatinIME';
  state.imeSetFails = true;

  expect(await rebindWith(state)).toBe(false);
  expect(isAndroidTestImeActive(DEVICE)).toBe(true);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
  expect(state.settings.get('agent_device_ime_helper_rebind_displaced')).toBe('1');
  expect(host.diagnostics).toContainEqual({
    phase: 'android_test_ime_rebind_failed',
    level: 'warn',
  });

  // The next open finds Android's fallback IME current; it must not become the restore target.
  state.imeSetFails = false;
  const result = await activateWith(state);

  expect(result).toMatchObject({ activated: true, previousIme: 'com.samsung/.Keyboard' });
  expect(state.settings.get('agent_device_ime_helper_previous_ime')).toBe('com.samsung/.Keyboard');
  expect(state.settings.has('agent_device_ime_helper_rebind_displaced')).toBe(false);
});

test('a rebind whose read-back throws is recorded as unconfirmed, not rejected', async () => {
  activationHost();
  const state: FakeImeDeviceState = {
    settings: new Map([['default_input_method', 'com.samsung/.Keyboard']]),
  };
  await activateWith(state);
  const deviceAdb = fakeImeDeviceAdb(state);
  let disabled = false;

  const rebound = await withAndroidAdbProvider(
    {
      exec: async (args) => {
        if (args[2] === 'disable') disabled = true;
        if (disabled && args[4] === 'default_input_method') throw new Error('adb timed out');
        return await deviceAdb(args);
      },
      imeHelperArtifact: ARTIFACT,
    },
    { serial: DEVICE.id },
    async () => await rebindAndroidTestIme(DEVICE),
  );

  expect(rebound).toBe(false);
  expect(state.settings.get('agent_device_ime_helper_rebind_displaced')).toBe('1');
  expect(isAndroidTestImeActive(DEVICE)).toBe(true);
});

test('a request canceled mid-rebind rejects as canceled and keeps the device record', async () => {
  activationHost();
  const state: FakeImeDeviceState = {
    settings: new Map([['default_input_method', 'com.samsung/.Keyboard']]),
  };
  await activateWith(state);
  const deviceAdb = fakeImeDeviceAdb(state);

  const rebind = withAndroidAdbProvider(
    {
      exec: async (args) => {
        if (args[2] === 'disable') throw createRequestCanceledError();
        return await deviceAdb(args);
      },
      imeHelperArtifact: ARTIFACT,
    },
    { serial: DEVICE.id },
    async () => await rebindAndroidTestIme(DEVICE),
  );

  await expect(rebind).rejects.toSatisfy(isRequestCanceledError);
  expect(state.settings.get('agent_device_ime_helper_rebind_displaced')).toBe('1');
  expect(isAndroidTestImeActive(DEVICE)).toBe(true);
});

test('a close-time restore waits for an in-flight rebind instead of racing it', async () => {
  activationHost();
  const state: FakeImeDeviceState = {
    settings: new Map([['default_input_method', 'com.samsung/.Keyboard']]),
  };
  await activateWith(state);
  const deviceAdb = fakeImeDeviceAdb(state);
  let releaseHelperSet = () => {};
  const helperSetGate = new Promise<void>((resolve) => {
    releaseHelperSet = resolve;
  });
  let helperSetReached = () => {};
  const reachedHelperSet = new Promise<void>((resolve) => {
    helperSetReached = resolve;
  });

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        if (args[2] === 'set' && args[3] === HELPER_SERVICE) {
          helperSetReached();
          await helperSetGate;
        }
        return await deviceAdb(args);
      },
      imeHelperArtifact: ARTIFACT,
    },
    { serial: DEVICE.id },
    async () => {
      const rebind = rebindAndroidTestIme(DEVICE);
      await reachedHelperSet;
      const restore = restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR });
      // Room for a restore that does not wait for the rebind to finish its own switch.
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseHelperSet();
      await rebind;
      expect(await restore).toMatchObject({ reason: 'ok' });
    },
  );

  expect(state.settings.get('default_input_method')).toBe('com.samsung/.Keyboard');
  expect(isAndroidTestImeActive(DEVICE)).toBe(false);
});
