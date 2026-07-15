import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';

const HELPER_SERVICE = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';
const SETTINGS_KEY = 'agent_device_ime_helper_previous_ime';
const PENDING_DIR = 'android-test-ime-pending';

// activateAndroidTestIme reads the bundled artifact for the service component; inject a fixture so
// the suite passes on a fresh checkout that hasn't packaged android/ime-helper/dist (CI Coverage).
vi.mock('../ime-helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ime-helper.ts')>();
  const fixture = await import('../../../__tests__/test-utils/android-snapshot-helper.ts');
  return {
    ...actual,
    resolveAndroidImeHelperArtifact: vi.fn(async () => ({
      apkPath: fixture.ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.apkPath,
      manifest: {
        name: 'android-ime-helper' as const,
        version: '0.0.0',
        assetName: 'helper.apk',
        sha256: fixture.ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.manifest.sha256,
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
const SERIAL = ANDROID_EMULATOR.id;

beforeEach(() => {
  resetAndroidImeHelperInstallCache();
  resetAndroidTestImeActivationCacheForTests();
});

async function makeStateDir(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'ime-lifecycle-state-'));
}

function pendingFile(stateDir: string, serial: string): string {
  return path.join(stateDir, PENDING_DIR, serial.replace(/[^a-zA-Z0-9._-]/g, '_'));
}

async function pendingMarkerExists(stateDir: string, serial: string): Promise<boolean> {
  try {
    await fsp.access(pendingFile(stateDir, serial));
    return true;
  } catch {
    return false;
  }
}

type FakeAdbResult = { exitCode: number; stdout: string; stderr: string };

function ok(stdout = ''): FakeAdbResult {
  return { exitCode: 0, stdout, stderr: '' };
}

// Handlers keyed by `shell <group> <action>`, dispatched by a single lookup in `adb` below.
function fakeDeviceState(initialIme: string) {
  let defaultIme = initialIme;
  let previousImeRecord: string | undefined;
  let installed = false;
  let failPersist = false;
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
    if (args[4] === SETTINGS_KEY) {
      if (failPersist) return { exitCode: 1, stdout: '', stderr: 'rejected' };
      previousImeRecord = args[5];
    }
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
    setFailPersist: (value: boolean) => {
      failPersist = value;
    },
    forceCurrentIme: (value: string) => {
      defaultIme = value;
    },
    getCurrentIme: () => defaultIme,
    getPreviousImeRecord: () => previousImeRecord,
  };
}

test('activateAndroidTestIme durably persists the previous IME and marks the device before switching', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();
  const stateDir = await makeStateDir();

  await withAndroidAdbProvider(state.adb, { serial: SERIAL }, async () => {
    const result = await activateAndroidTestIme(ANDROID_EMULATOR, { stateDir });
    assert.equal(result.activated, true);
    assert.equal(result.previousIme, LATIN_IME);
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);
    assert.equal(state.getPreviousImeRecord(), LATIN_IME);
    assert.equal(isAndroidTestImeActive(ANDROID_EMULATOR), true);
    // Recovery marker written for this device.
    assert.equal(await pendingMarkerExists(stateDir, SERIAL), true);
  });
});

test('activateAndroidTestIme fails open (no IME switch) when the previous IME cannot be persisted', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();
  state.setFailPersist(true); // `settings put` is rejected
  const stateDir = await makeStateDir();

  await withAndroidAdbProvider(state.adb, { serial: SERIAL }, async () => {
    const result = await activateAndroidTestIme(ANDROID_EMULATOR, { stateDir });

    assert.equal(result.activated, false);
    assert.equal(result.persistFailed, true);
    // Must NOT switch the IME — the user falls open to the existing input path.
    assert.equal(state.getCurrentIme(), LATIN_IME);
    assert.equal(state.getPreviousImeRecord(), undefined);
    assert.equal(isAndroidTestImeActive(ANDROID_EMULATOR), false);
    // No marker: nothing was switched, so there is nothing to recover.
    assert.equal(await pendingMarkerExists(stateDir, SERIAL), false);
  });
});

test('restoreAndroidTestIme restores the previous IME, clears the record and the marker', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();
  const stateDir = await makeStateDir();

  await withAndroidAdbProvider(state.adb, { serial: SERIAL }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR, { stateDir });
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);

    const restoreResult = await restoreAndroidTestIme(ANDROID_EMULATOR, { stateDir });
    assert.equal(restoreResult.restored, true);
    assert.equal(restoreResult.previousIme, LATIN_IME);
    assert.equal(state.getCurrentIme(), LATIN_IME);
    assert.equal(state.getPreviousImeRecord(), undefined);
    assert.equal(isAndroidTestImeActive(ANDROID_EMULATOR), false);
    assert.equal(await pendingMarkerExists(stateDir, SERIAL), false);
  });
});

test('restoreAndroidTestIme is a no-op when nothing was ever activated', async () => {
  const state = fakeDeviceState(LATIN_IME);

  await withAndroidAdbProvider(state.adb, { serial: SERIAL }, async () => {
    const result = await restoreAndroidTestIme(ANDROID_EMULATOR);
    assert.equal(result.restored, false);
  });
});

test('a failed restore keeps the recovery value AND the marker for a later retry', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();
  const stateDir = await makeStateDir();

  await withAndroidAdbProvider(state.adb, { serial: SERIAL }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR, { stateDir });
    state.blockImeSetTo(LATIN_IME); // device refuses to switch back

    const result = await restoreAndroidTestIme(ANDROID_EMULATOR, { stateDir });

    assert.equal(result.restored, false);
    assert.equal(result.reason, 'set-failed');
    // Still stranded on the helper — the recovery value AND the pending marker both survive so a
    // later retry / startup recovery can still un-strand the user.
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);
    assert.equal(state.getPreviousImeRecord(), LATIN_IME);
    assert.equal(await pendingMarkerExists(stateDir, SERIAL), true);
  });

  // A subsequent recovery (device now accepts the switch) uses the surviving state and succeeds.
  state.unblockImeSetTo(LATIN_IME);
  state.forceCurrentIme(HELPER_SERVICE);
  await withAndroidAdbProvider(state.adb, { serial: SERIAL }, async () => {
    await restoreOrphanedAndroidTestImeOnDaemonStartup({
      stateDir,
      listSerials: async () => [SERIAL],
    });
    assert.equal(state.getCurrentIme(), LATIN_IME);
    assert.equal(state.getPreviousImeRecord(), undefined);
    assert.equal(await pendingMarkerExists(stateDir, SERIAL), false);
  });
});

test('startup recovery does not scan adb when no pending marker exists', async () => {
  const stateDir = await makeStateDir(); // no markers: this host never used the test IME
  let listSerialsCalled = false;
  await restoreOrphanedAndroidTestImeOnDaemonStartup({
    stateDir,
    listSerials: async () => {
      listSerialsCalled = true;
      return [SERIAL];
    },
  });
  // The adb scan (listSerials -> `adb devices`) must not run — the macOS-CI regression fix.
  assert.equal(listSerialsCalled, false);
});

test('startup recovery leaves an offline device stuck-but-pending, then restores it on reconnect', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();
  const stateDir = await makeStateDir();

  await withAndroidAdbProvider(state.adb, { serial: SERIAL }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR, { stateDir });
    resetAndroidTestImeActivationCacheForTests(); // process "crashed"; device left on helper

    // Restart while the device is OFFLINE: it must not be forgotten.
    await restoreOrphanedAndroidTestImeOnDaemonStartup({ stateDir, listSerials: async () => [] });
    assert.equal(state.getCurrentIme(), HELPER_SERVICE); // still stuck (offline, not touched)
    assert.equal(await pendingMarkerExists(stateDir, SERIAL), true); // marker retained

    // Device reconnects on a later restart: now recovered and cleared.
    await restoreOrphanedAndroidTestImeOnDaemonStartup({
      stateDir,
      listSerials: async () => [SERIAL],
    });
    assert.equal(state.getCurrentIme(), LATIN_IME);
    assert.equal(await pendingMarkerExists(stateDir, SERIAL), false);
  });
});

test('startup recovery is a no-op on the IME when the current IME is no longer the helper', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();
  const stateDir = await makeStateDir();

  await withAndroidAdbProvider(state.adb, { serial: SERIAL }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR, { stateDir });
    resetAndroidTestImeActivationCacheForTests(); // process "crashed"; record persists on device
    // The user (or another tool) has since legitimately switched to a different IME.
    const OTHER_IME = 'com.example.other/.OtherIme';
    state.forceCurrentIme(OTHER_IME);

    await restoreOrphanedAndroidTestImeOnDaemonStartup({
      stateDir,
      listSerials: async () => [SERIAL],
    });

    // Startup recovery must NOT overwrite the user's current choice.
    assert.equal(state.getCurrentIme(), OTHER_IME);
    // It must not clear the device record (a concurrent activation could have just written it)...
    assert.equal(state.getPreviousImeRecord(), LATIN_IME);
    // ...but the device is observed clean (helper not active), so its pending marker is cleared.
    assert.equal(await pendingMarkerExists(stateDir, SERIAL), false);
  });
});

test('startup recovery skips (and keeps the marker for) a device a live session still owns', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();
  const stateDir = await makeStateDir();

  await withAndroidAdbProvider(state.adb, { serial: SERIAL }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR, { stateDir });
    assert.equal(isAndroidTestImeActive(ANDROID_EMULATOR), true);
    // Fire-and-forget startup recovery races an open that just activated the helper here.
    await restoreOrphanedAndroidTestImeOnDaemonStartup({
      stateDir,
      listSerials: async () => [SERIAL],
    });

    // The live session keeps the helper active; recovery leaves it alone and retains the marker.
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);
    assert.equal(state.getPreviousImeRecord(), LATIN_IME);
    assert.equal(await pendingMarkerExists(stateDir, SERIAL), true);
  });
});

test('startup recovery restores a stuck IME left by a crashed daemon and clears the marker', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();
  const stateDir = await makeStateDir();

  await withAndroidAdbProvider(state.adb, { serial: SERIAL }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR, { stateDir });
    resetAndroidTestImeActivationCacheForTests(); // process "crashed" -- in-memory cache is gone
    assert.equal(state.getCurrentIme(), HELPER_SERVICE);

    await restoreOrphanedAndroidTestImeOnDaemonStartup({
      stateDir,
      listSerials: async () => [SERIAL],
    });

    assert.equal(state.getCurrentIme(), LATIN_IME);
    assert.equal(await pendingMarkerExists(stateDir, SERIAL), false);
  });
});

test('startup recovery tolerates a serial listing failure and keeps the marker', async () => {
  const state = fakeDeviceState(LATIN_IME);
  state.markInstalled();
  const stateDir = await makeStateDir();
  await withAndroidAdbProvider(state.adb, { serial: SERIAL }, async () => {
    await activateAndroidTestIme(ANDROID_EMULATOR, { stateDir });
    resetAndroidTestImeActivationCacheForTests();
    await restoreOrphanedAndroidTestImeOnDaemonStartup({
      stateDir,
      listSerials: async () => {
        throw new Error('adb not found');
      },
    });
    // The listing failed, so the marker is retained for a later retry.
    assert.equal(await pendingMarkerExists(stateDir, SERIAL), true);
  });
});
