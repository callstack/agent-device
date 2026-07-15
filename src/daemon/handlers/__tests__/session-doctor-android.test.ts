import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const HELPER_SERVICE = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';
const NORMAL_IME = 'com.google.android.inputmethod.latin/.LatinIME';

// probeAndroidTestIme reads the helper's service component from the bundled artifact; inject a
// fixture so the orphan-detection checks pass on a fresh checkout that hasn't packaged
// android/ime-helper/dist (CI's Coverage job runs no packaging step).
vi.mock('../../../platforms/android/ime-helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platforms/android/ime-helper.ts')>();
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
import { appendAndroidChecks } from '../session-doctor-android.ts';
import {
  resetAndroidTestImeActivationCacheForTests,
  setAndroidTestImeActiveForTests,
} from '../../../platforms/android/ime-lifecycle.ts';
import type { AndroidAdbExecutor } from '../../../platforms/android/adb-executor.ts';
import type { DoctorCheck } from '../session-doctor-types.ts';

afterEach(() => {
  resetAndroidTestImeActivationCacheForTests();
});

function fakeAdb(currentIme: string, previousIme = 'null'): AndroidAdbExecutor {
  return async (args) => {
    if (args[2] === 'get' && args[4] === 'default_input_method') {
      return { exitCode: 0, stdout: currentIme, stderr: '' };
    }
    if (args[2] === 'get' && args[4] === 'agent_device_ime_helper_previous_ime') {
      return { exitCode: 0, stdout: previousIme, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

async function runImeCheck(adb: AndroidAdbExecutor): Promise<DoctorCheck | undefined> {
  const checks: DoctorCheck[] = [];
  await appendAndroidChecks(checks, {
    device: ANDROID_EMULATOR,
    metroPort: 8081,
    shouldProbeMetro: false,
    androidAdbExecutor: adb,
  });
  return checks.find((check) => check.id === 'android-test-ime');
}

test('reports pass when the normal IME is active', async () => {
  const check = await runImeCheck(fakeAdb(NORMAL_IME));
  assert.equal(check?.status, 'pass');
  assert.match(check?.summary ?? '', /not active/);
});

test('reports pass when this process owns the active test IME', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const check = await runImeCheck(fakeAdb(HELPER_SERVICE));
  assert.equal(check?.status, 'pass');
  assert.match(check?.summary ?? '', /active for this session/);
});

test('reports fail with a remediation command when the test IME is orphaned', async () => {
  const check = await runImeCheck(fakeAdb(HELPER_SERVICE, NORMAL_IME));
  assert.equal(check?.status, 'fail');
  assert.equal(check?.command, `adb -s ${ANDROID_EMULATOR.id} shell ime set ${NORMAL_IME}`);
  assert.equal(check?.evidence?.previousIme, NORMAL_IME);
});

test('falls back to ime list -s when no previous-IME record was persisted', async () => {
  const check = await runImeCheck(fakeAdb(HELPER_SERVICE));
  assert.equal(check?.status, 'fail');
  assert.equal(check?.command, `adb -s ${ANDROID_EMULATOR.id} shell ime list -s`);
});
