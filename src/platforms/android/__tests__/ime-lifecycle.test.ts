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

const LATIN_IME = 'com.google.android.inputmethod.latin/.LatinIME';

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
  // `ime set <target>` for a blocked target reports success but does not change the active IME —
  // simulates a device that refuses the switch (so the restore read-back mismatches).
  const blockedImeSetTargets = new Set<string>();

  function handleShowVersionCode(): FakeAdbResult {
    return installed
      ? ok('package:com.callstack.agentdevice.imehelper versionCode:19002')
      : { exitCode: 1, stdout: '', stderr: 'not found' };
  }

  function handleImeSet(args: string[]): FakeAdbResult {
    const target = args[3] as string;
    if (blockedImeSetTargets.has(target)) return ok();
    defaultIme = target;
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
    blockImeSetTo: (target: string) => blockedImeSetTargets.add(target),
    unblockImeSetTo: (target: string) => blockedImeSetTargets.delete(target),
    forceCurrentIme: (value: string) => {
      defaultIme = value;
    },
    getCurrentIme: () => defaultIme,
    getPreviousImeRecord: () => previousImeRecord,
  };
}

test('activateAndroidTestIme persists the previous IME before switching', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();

  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    const result = await activateAndroidTestIme(ANDROID_EMULATOR);
    assert.equal(result.activated, true);
    assert.equal(result.previousIme, LATIN_IME);
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);
    assert.equal(state.getPreviousImeRecord(), LATIN_IME);
    assert.equal(isAndroidTestImeActive(ANDROID_EMULATOR), true);
  });
});

test('restoreAndroidTestIme restores the persisted previous IME and clears the record', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();

  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR);
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);

    const restoreResult = await restoreAndroidTestIme(ANDROID_EMULATOR);
    assert.equal(restoreResult.restored, true);
    assert.equal(restoreResult.previousIme, LATIN_IME);
    assert.equal(state.getCurrentIme(), LATIN_IME);
    assert.equal(state.getPreviousImeRecord(), undefined);
    assert.equal(isAndroidTestImeActive(ANDROID_EMULATOR), false);
  });
});

test('restoreAndroidTestIme is a no-op when nothing was ever activated', async () => {
  const state = fakeDeviceState(LATIN_IME);

  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    const result = await restoreAndroidTestIme(ANDROID_EMULATOR);
    assert.equal(result.restored, false);
  });
});

test('a failed restore keeps the persisted recovery value for a later retry', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();

  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR);
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);
    // Device refuses to switch back to the previous IME.
    state.blockImeSetTo(LATIN_IME);

    const result = await restoreAndroidTestIme(ANDROID_EMULATOR);

    assert.equal(result.restored, false);
    assert.equal(result.reason, 'set-failed');
    // Still stranded on the helper, and — critically — the recovery value survives so a later
    // retry / startup recovery / doctor remediation can still un-strand the user.
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);
    assert.equal(state.getPreviousImeRecord(), LATIN_IME);
  });

  // A subsequent recovery (device now accepts the switch) uses the surviving value and succeeds.
  state.unblockImeSetTo(LATIN_IME);
  state.forceCurrentIme(HELPER_SERVICE);
  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    await restoreOrphanedAndroidTestImeOnDaemonStartup({
      listSerials: async () => [ANDROID_EMULATOR.id],
    });
    assert.equal(state.getCurrentIme(), LATIN_IME);
    assert.equal(state.getPreviousImeRecord(), undefined);
  });
});

test('startup recovery is a no-op when the current IME is no longer the helper', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();

  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR);
    resetAndroidTestImeActivationCacheForTests(); // process "crashed"; record persists on device
    // The user (or another tool) has since legitimately switched to a different IME.
    const OTHER_IME = 'com.example.other/.OtherIme';
    state.forceCurrentIme(OTHER_IME);

    await restoreOrphanedAndroidTestImeOnDaemonStartup({
      listSerials: async () => [ANDROID_EMULATOR.id],
    });

    // Startup recovery must NOT overwrite the user's current choice with the stale recorded value.
    assert.equal(state.getCurrentIme(), OTHER_IME);
    // And it must not clear the record either (a concurrent activation could have just written it).
    assert.equal(state.getPreviousImeRecord(), LATIN_IME);
  });
});

test('startup recovery skips a device a live session in this process still owns', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();

  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR);
    assert.equal(isAndroidTestImeActive(ANDROID_EMULATOR), true);
    // Fire-and-forget startup recovery races an open that just activated the helper here.
    await restoreOrphanedAndroidTestImeOnDaemonStartup({
      listSerials: async () => [ANDROID_EMULATOR.id],
    });

    // The live session keeps the helper active; recovery leaves it alone.
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);
    assert.equal(state.getPreviousImeRecord(), LATIN_IME);
  });
});

test('restoreOrphanedAndroidTestImeOnDaemonStartup restores a stuck IME left by a crashed daemon', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();

  await withAndroidAdbProvider(state.adb, { serial: ANDROID_EMULATOR.id }, async () => {
    // Simulate a previous process that activated the helper but crashed before restoring.
    await activateAndroidTestIme(ANDROID_EMULATOR);
    resetAndroidTestImeActivationCacheForTests(); // process "crashed" -- in-memory cache is gone
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);

    await restoreOrphanedAndroidTestImeOnDaemonStartup({
      listSerials: async () => [ANDROID_EMULATOR.id],
    });

    assert.equal(state.getCurrentIme(), LATIN_IME);
  });
});

test('restoreOrphanedAndroidTestImeOnDaemonStartup tolerates a serial listing failure', async () => {
  await restoreOrphanedAndroidTestImeOnDaemonStartup({
    listSerials: async () => {
      throw new Error('adb not found');
    },
  });
});
