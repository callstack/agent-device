import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const HELPER_SERVICE = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';
const SETTINGS_KEY = 'agent_device_ime_helper_previous_ime';

// activateAndroidTestIme reads the bundled artifact for the service component; inject a fixture so
// the suite passes on a fresh checkout that hasn't packaged android-ime-helper/dist (CI Coverage).
vi.mock('../ime-helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ime-helper.ts')>();
  return {
    ...actual,
    resolveAndroidImeHelperArtifact: vi.fn(async () => ({
      apkPath: '/fixture/helper.apk',
      manifest: {
        name: 'android-ime-helper' as const,
        version: '0.0.0',
        assetName: 'helper.apk',
        sha256: 'a'.repeat(64),
        packageName: 'com.callstack.agentdevice.imehelper',
        versionCode: 1,
        serviceComponent: HELPER_SERVICE,
        broadcastProtocol: 'android-ime-helper-v1' as const,
      },
    })),
  };
});

import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/index.ts';
import { withAndroidAdbProvider, type AndroidAdbExecutor } from '../adb-executor.ts';
import { resetAndroidImeHelperInstallCache } from '../ime-helper.ts';
import {
  activateAndroidTestIme,
  isAndroidTestImeActive,
  restoreAndroidTestIme,
  restoreOrphanedAndroidTestImeOnDaemonStartup,
  resetAndroidTestImeActivationCacheForTests,
} from '../ime-lifecycle.ts';

beforeEach(() => {
  resetAndroidImeHelperInstallCache();
  resetAndroidTestImeActivationCacheForTests();
});

type FakeAdbResult = { exitCode: number; stdout: string; stderr: string };

function ok(stdout = ''): FakeAdbResult {
  return { exitCode: 0, stdout, stderr: '' };
}

// Handlers keyed by `shell <group> <action>`, dispatched by a single lookup in `adb` below.
function fakeDeviceState(initialIme: string) {
  let defaultIme = initialIme;
  let previousImeRecord: string | undefined;
  let installed = false;

  function handleShowVersionCode(): FakeAdbResult {
    return installed
      ? ok('package:com.callstack.agentdevice.imehelper versionCode:19002')
      : { exitCode: 1, stdout: '', stderr: 'not found' };
  }

  function handleImeSet(args: string[]): FakeAdbResult {
    defaultIme = args[3] as string;
    return ok();
  }

  function handleSettingsGet(args: string[]): FakeAdbResult {
    const key = args[4];
    if (key === 'default_input_method') return ok(defaultIme);
    if (key === SETTINGS_KEY) return ok(previousImeRecord ?? 'null');
    throw new Error(`unexpected settings get key: ${String(key)}`);
  }

  function handleSettingsPut(args: string[]): FakeAdbResult {
    if (args[4] === SETTINGS_KEY) previousImeRecord = args[5];
    return ok();
  }

  function handleSettingsDelete(args: string[]): FakeAdbResult {
    if (args[4] === SETTINGS_KEY) previousImeRecord = undefined;
    return ok();
  }

  const handlers: Record<string, (args: string[]) => FakeAdbResult> = {
    'shell ime enable': () => ok(),
    'shell ime set': handleImeSet,
    'shell settings get': handleSettingsGet,
    'shell settings put': handleSettingsPut,
    'shell settings delete': handleSettingsDelete,
  };

  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) return handleShowVersionCode();
    const handler = handlers[args.slice(0, 3).join(' ')];
    if (!handler) throw new Error(`unexpected adb call: ${args.join(' ')}`);
    return handler(args);
  };

  return {
    adb,
    markInstalled: () => {
      installed = true;
    },
    getCurrentIme: () => defaultIme,
    getPreviousImeRecord: () => previousImeRecord,
  };
}

test('activateAndroidTestIme persists the previous IME before switching', async () => {
  const state = fakeDeviceState('com.google.android.inputmethod.latin/.LatinIME');
  state.markInstalled();

  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    const result = await activateAndroidTestIme(ANDROID_EMULATOR);
    assert.equal(result.activated, true);
    assert.equal(result.previousIme, 'com.google.android.inputmethod.latin/.LatinIME');
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);
    assert.equal(state.getPreviousImeRecord(), 'com.google.android.inputmethod.latin/.LatinIME');
    assert.equal(isAndroidTestImeActive(ANDROID_EMULATOR), true);
  });
});

test('restoreAndroidTestIme restores the persisted previous IME and clears the record', async () => {
  const state = fakeDeviceState('com.google.android.inputmethod.latin/.LatinIME');
  state.markInstalled();

  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR);
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);

    const restoreResult = await restoreAndroidTestIme(ANDROID_EMULATOR);
    assert.equal(restoreResult.restored, true);
    assert.equal(restoreResult.previousIme, 'com.google.android.inputmethod.latin/.LatinIME');
    assert.equal(state.getCurrentIme(), 'com.google.android.inputmethod.latin/.LatinIME');
    assert.equal(state.getPreviousImeRecord(), undefined);
    assert.equal(isAndroidTestImeActive(ANDROID_EMULATOR), false);
  });
});

test('restoreAndroidTestIme is a no-op when nothing was ever activated', async () => {
  const state = fakeDeviceState('com.google.android.inputmethod.latin/.LatinIME');

  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    const result = await restoreAndroidTestIme(ANDROID_EMULATOR);
    assert.equal(result.restored, false);
  });
});

test('restoreOrphanedAndroidTestImeOnDaemonStartup restores a stuck IME left by a crashed daemon', async () => {
  const state = fakeDeviceState('com.google.android.inputmethod.latin/.LatinIME');
  state.markInstalled();

  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    // Simulate a previous process that activated the helper but crashed before restoring.
    await activateAndroidTestIme(ANDROID_EMULATOR);
    resetAndroidTestImeActivationCacheForTests(); // process "crashed" -- in-memory cache is gone
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);

    await restoreOrphanedAndroidTestImeOnDaemonStartup({
      listSerials: async () => [ANDROID_EMULATOR.id],
    });

    assert.equal(state.getCurrentIme(), 'com.google.android.inputmethod.latin/.LatinIME');
  });
});

test('restoreOrphanedAndroidTestImeOnDaemonStartup tolerates a serial listing failure', async () => {
  await restoreOrphanedAndroidTestImeOnDaemonStartup({
    listSerials: async () => {
      throw new Error('adb not found');
    },
  });
});
