import { beforeEach, expect, test } from 'vitest';
import { createRequestCanceledError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { ANDROID_EMULATOR as DEVICE } from './__tests__/test-utils/device-fixtures.ts';
import type { AndroidImeHelperArtifact } from './helper-artifacts.ts';
import type { AndroidAdbExecutor } from './adb-transport.ts';
import { bindAndroidAdbHostStub, type AndroidAdbHostStub } from './adb-host.fixtures.ts';
import { withAndroidAdbProvider } from './adb-provider-scope.ts';
import { activateAndroidTestIme } from './ime-activation.ts';
import { rebindAndroidTestIme } from './ime-rebind.ts';
import { typeAndroid } from './text-input.ts';
import { restoreAndroidTestIme } from './ime-restore.ts';
import { fakeImeDeviceAdb, type FakeImeDeviceState } from './ime-device.fixtures.ts';
import {
  getAndroidTestImeOwnership,
  isAndroidTestImeActive,
  resetAndroidTestImeActivationCacheForTests,
} from './ime-state.ts';
import { resetAndroidImeHelperInstallCache } from './ime-helper.ts';

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

let state: FakeImeDeviceState;
let host: AndroidAdbHostStub;

beforeEach(async () => {
  resetAndroidTestImeActivationCacheForTests();
  resetAndroidImeHelperInstallCache();
  host = activationHost();
  state = { settings: new Map([['default_input_method', 'com.samsung/.Keyboard']]) };
  await activateWith(state);
});

test("a rebind that displaces the helper keeps ownership and the user's IME as restore target", async () => {
  state.imeDisableFallback = 'com.android.inputmethod.latin/.LatinIME';
  state.imeSetFails = true;

  expect(await withDeviceAdb(fakeImeDeviceAdb(state), () => rebindAndroidTestIme(DEVICE))).toEqual({
    kind: 'unconfirmed',
    cause: 'command-failed',
  });
  expect(isAndroidTestImeActive(DEVICE)).toBe(true);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
  expect(state.settings.get('agent_device_ime_helper_rebind_displaced')).toBe('1');

  // The next open finds Android's fallback IME current; it must not become the restore target.
  state.imeSetFails = false;
  const result = await activateWith(state);

  expect(result).toMatchObject({ activated: true, previousIme: 'com.samsung/.Keyboard' });
  expect(state.settings.get('agent_device_ime_helper_previous_ime')).toBe('com.samsung/.Keyboard');
  expect(state.settings.has('agent_device_ime_helper_rebind_displaced')).toBe(false);
});

test('a request canceled mid-rebind rejects as canceled and keeps the device record', async () => {
  const deviceAdb = fakeImeDeviceAdb(state);

  const rebind = withDeviceAdb(
    async (args) => {
      if (args[2] === 'disable') throw createRequestCanceledError();
      return await deviceAdb(args);
    },
    async () => await rebindAndroidTestIme(DEVICE),
  );

  await expect(rebind).rejects.toSatisfy(isRequestCanceledError);
  expect(state.settings.get('agent_device_ime_helper_rebind_displaced')).toBe('1');
  expect(isAndroidTestImeActive(DEVICE)).toBe(true);
});

test('a close-time restore waits for an in-flight rebind instead of racing it', async () => {
  const deviceAdb = fakeImeDeviceAdb(state);
  let releaseHelperSet = () => {};
  const helperSetGate = new Promise<void>((resolve) => {
    releaseHelperSet = resolve;
  });
  let helperSetReached = () => {};
  const reachedHelperSet = new Promise<void>((resolve) => {
    helperSetReached = resolve;
  });

  await withDeviceAdb(
    async (args) => {
      if (args[2] === 'set' && args[3] === HELPER_SERVICE) {
        helperSetReached();
        await helperSetGate;
      }
      return await deviceAdb(args);
    },
    async () => {
      const rebind = rebindAndroidTestIme(DEVICE);
      await reachedHelperSet;
      const restore = restoreAndroidTestIme(DEVICE, { stateDir: STATE_DIR });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(state.settings.get('default_input_method')).toBe(HELPER_SERVICE);
      releaseHelperSet();
      await rebind;
      expect(await restore).toMatchObject({ reason: 'ok' });
    },
  );

  expect(state.settings.get('default_input_method')).toBe('com.samsung/.Keyboard');
  expect(isAndroidTestImeActive(DEVICE)).toBe(false);
});

async function withDeviceAdb<T>(exec: AndroidAdbExecutor, task: () => Promise<T>): Promise<T> {
  return await withAndroidAdbProvider(
    { exec, imeHelperArtifact: ARTIFACT },
    { serial: DEVICE.id },
    task,
  );
}

const REBIND_DISPLACED = 'agent_device_ime_helper_rebind_displaced';

test.each([
  ['write rejected', 'put', 'agent_device_ime_helper_rebind_displaced', false, 'record-write'],
  ['write throws', 'put', 'agent_device_ime_helper_rebind_displaced', true, 'record-write'],
  ['read throws', 'get', 'default_input_method', true, 'read-failed'],
] as const)('%s leaves the rebind unconfirmed', async (_name, action, key, throws, cause) => {
  const deviceAdb = fakeImeDeviceAdb(state);
  const rebound = await withDeviceAdb(
    async (args) => {
      if (args[1] === 'settings' && args[2] === action && args[4] === key) {
        if (throws) throw new Error('adb timed out');
        return { exitCode: 1, stdout: '', stderr: 'rejected' };
      }
      return await deviceAdb(args);
    },
    () => rebindAndroidTestIme(DEVICE),
  );
  expect(rebound).toEqual({ kind: 'unconfirmed', cause });
  expect(getAndroidTestImeOwnership(DEVICE)?.rebindUnconfirmed).toBe(true);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
  expect(state.settings.get('agent_device_ime_helper_previous_ime')).toBe('com.samsung/.Keyboard');
  if (action === 'get') expect(state.settings.get(REBIND_DISPLACED)).toBe('1');
});

test.each(['disable', 'enable', 'set'])('a failed ime %s never confirms a rebind', async (verb) => {
  const deviceAdb = fakeImeDeviceAdb(state);
  const rebound = await withDeviceAdb(
    async (args) =>
      args[1] === 'ime' && args[2] === verb
        ? { exitCode: 1, stdout: '', stderr: 'rejected' }
        : await deviceAdb(args),
    async () => await rebindAndroidTestIme(DEVICE),
  );
  expect(rebound).toEqual({ kind: 'unconfirmed', cause: 'command-failed' });
  expect(state.settings.get(REBIND_DISPLACED)).toBe('1');
  expect(isAndroidTestImeActive(DEVICE)).toBe(true);
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
});

test('a confirmed rebind whose device record stays set is retried at the next entry', async () => {
  const deviceAdb = fakeImeDeviceAdb(state);

  const rebound = await withDeviceAdb(
    async (args) =>
      args[1] === 'settings' && args[2] === 'delete' && args[4] === REBIND_DISPLACED
        ? { exitCode: 1, stdout: '', stderr: 'rejected' }
        : await deviceAdb(args),
    async () => await rebindAndroidTestIme(DEVICE),
  );

  expect(rebound).toEqual({ kind: 'confirmed' });
  expect(state.settings.get('agent_device_ime_helper_previous_ime')).toBe('com.samsung/.Keyboard');
  expect([...(host.markerStore.get(STATE_DIR) ?? [])]).toEqual([DEVICE.id]);
  expect(state.settings.get(REBIND_DISPLACED)).toBe('1');
  const calls: string[] = [];
  await withDeviceAdb(
    async (args) => {
      calls.push(`${args[1]} ${args[2]}`);
      return args[1] === 'am' ? { exitCode: 0, stdout: '', stderr: '' } : await deviceAdb(args);
    },
    async () => await typeAndroid(DEVICE, 'Jane'),
  );
  expect(calls.indexOf('ime set')).toBeLessThan(calls.indexOf('am broadcast'));
  expect(calls).toContain('ime set');
  expect(calls).toContain('am broadcast');
  expect(state.settings.has(REBIND_DISPLACED)).toBe(false);
  expect(getAndroidTestImeOwnership(DEVICE)?.rebindUnconfirmed).toBe(false);
});
