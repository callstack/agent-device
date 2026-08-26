import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const HELPER_SERVICE = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';
const NORMAL_IME = 'com.google.android.inputmethod.latin/.LatinIME';

// probeAndroidTestIme reads the helper's service component from the bundled artifact; inject a
// fixture so the orphan-detection checks pass on a fresh checkout that hasn't packaged
// android/ime-helper/dist (CI's Coverage job runs no packaging step).
vi.mock('@agent-device/platform-android/ime-helper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/ime-helper')>();
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

import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import type { HostDiagnosticsContext } from '@agent-device/contracts/host-diagnostics';
import { androidDeviceChecks } from '../doctor.ts';
import {
  resetAndroidTestImeActivationCacheForTests,
  setAndroidTestImeActiveForTests,
} from '../ime-lifecycle.ts';
import type { AndroidAdbExecutor } from '../adb-executor.ts';
import type { DoctorCheck } from '@agent-device/contracts/observability';

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

function contextWith(adb: AndroidAdbExecutor): HostDiagnosticsContext {
  return Object.freeze({
    stateDir: '/tmp/state',
    metroPort: 8081,
    shouldProbeMetro: false,
    isProviderDevice: () => false,
    emitProgress: () => {},
    listLocalDeviceInventory: async () => [],
    shouldPropagateInventoryProbeError: () => false,
    transportOverrides: Object.freeze({ androidAdb: adb }),
  });
}

async function runImeCheck(adb: AndroidAdbExecutor): Promise<DoctorCheck | undefined> {
  const checks = await androidDeviceChecks(ANDROID_EMULATOR, contextWith(adb));
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
