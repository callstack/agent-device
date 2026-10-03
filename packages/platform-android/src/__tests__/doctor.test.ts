import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';

const HELPER_SERVICE = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';
const NORMAL_IME = 'com.google.android.inputmethod.latin/.LatinIME';

// probeAndroidTestIme reads the helper's service component from the bundled artifact; inject a
// fixture so the orphan-detection checks pass on a fresh checkout that hasn't packaged
// android/ime-helper/dist (CI's Coverage job runs no packaging step).
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

import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import type { HostDiagnosticsContext } from '@agent-device/contracts/host-diagnostics';
import { androidDeviceChecks, androidToolchainCheck } from '../doctor.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';
import {
  resetAndroidTestImeActivationCacheForTests,
  setAndroidTestImeActiveForTests,
} from '../ime-lifecycle.ts';
import type { AndroidAdbExecutor } from '../adb-executor.ts';
import type { DoctorCheck } from '@agent-device/contracts/observability';

afterEach(() => {
  resetAndroidTestImeActivationCacheForTests();
  vi.unstubAllEnvs();
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

const WINDOWS_ADB_PATH = String.raw`C:\Users\dev\AppData\Local\Android\Sdk\platform-tools\adb.exe`;
const WINDOWS_ADB_VERSION = [
  'Android Debug Bridge version 1.0.41',
  'Version 35.0.2-12147458',
  `Installed as ${WINDOWS_ADB_PATH}`,
  'Running on Windows 10.0.26100',
].join('\n');
const LINUX_ADB_VERSION = [
  'Android Debug Bridge version 1.0.41',
  'Version 35.0.2-12147458',
  'Installed as /home/dev/Android/Sdk/platform-tools/adb',
  'Running on Linux 6.18.0-microsoft-standard-WSL2 (x86_64)',
].join('\n');
// adb builds before 1.0.36 and some third-party builds omit the `Installed as` banner, leaving the
// `Running on Windows` line as the only signal that the binary is a Windows one.
const WINDOWS_ADB_VERSION_WITHOUT_INSTALL_PATH = [
  'Android Debug Bridge version 1.0.39',
  'Running on Windows 10.0.26100',
].join('\n');
const LINUX_ADB_VERSION_WITHOUT_INSTALL_PATH = [
  'Android Debug Bridge version 1.0.39',
  'Running on Linux 6.18.0 (x86_64)',
].join('\n');

async function toolchainCheckWithAdbVersion(
  versionOutput: string,
  hostPlatform: NodeJS.Platform = 'linux',
): Promise<DoctorCheck> {
  const binDir = await mkdtempForTest('agent-device-android-doctor-');
  const adbPath = path.join(binDir, 'adb');
  await fs.writeFile(adbPath, `#!/bin/sh\ncat <<'EOF'\n${versionOutput}\nEOF\n`, 'utf8');
  await fs.chmod(adbPath, 0o755);
  vi.stubEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH ?? ''}`);
  return await androidToolchainCheck(
    { ANDROID_HOME: '/mnt/c/Users/dev/AppData/Local/Android/Sdk' },
    hostPlatform,
    { access: async () => {} },
  );
}

test('fails the toolchain when adb on a POSIX host is the Windows binary', async () => {
  const check = await toolchainCheckWithAdbVersion(WINDOWS_ADB_VERSION);
  assert.equal(check.status, 'fail');
  assert.equal(check.evidence?.reason, 'android_adb_windows_binary_on_posix_host');
  assert.equal(check.evidence?.detectedVia, 'installed-as-path');
  assert.equal(check.evidence?.adbPath, WINDOWS_ADB_PATH);
  assert.match(check.summary ?? '', /Windows binary/);
  assert.match(check.hint ?? '', /native binary for this host/);
  assert.match(check.hint ?? '', /Under WSL/);
});

test('names the invariant in the hint for a non-WSL host reaching a Windows adb', async () => {
  const check = await toolchainCheckWithAdbVersion(WINDOWS_ADB_VERSION, 'darwin');
  assert.equal(check.status, 'fail');
  assert.equal(check.evidence?.detectedVia, 'installed-as-path');
  assert.match(check.hint ?? '', /^adb must be a native binary for this host/);
});

test('fails the toolchain from the Running on Windows line when adb omits Installed as', async () => {
  const check = await toolchainCheckWithAdbVersion(WINDOWS_ADB_VERSION_WITHOUT_INSTALL_PATH);
  assert.equal(check.status, 'fail');
  assert.equal(check.evidence?.reason, 'android_adb_windows_binary_on_posix_host');
  assert.equal(check.evidence?.detectedVia, 'running-on-line');
  assert.equal(check.evidence?.adbPath, null);
});

test('keeps a native binary passing when adb omits Installed as', async () => {
  const check = await toolchainCheckWithAdbVersion(LINUX_ADB_VERSION_WITHOUT_INSTALL_PATH);
  assert.equal(check.status, 'pass');
  assert.equal(check.evidence?.reason, undefined);
});

test('passes the toolchain when adb is the Linux binary, even under WSL', async () => {
  const check = await toolchainCheckWithAdbVersion(LINUX_ADB_VERSION);
  assert.equal(check.status, 'pass');
  assert.equal(check.evidence?.reason, undefined);
});

test('passes the toolchain when the Windows binary runs on a Windows host', async () => {
  const check = await toolchainCheckWithAdbVersion(WINDOWS_ADB_VERSION, 'win32');
  assert.equal(check.status, 'pass');
  assert.equal(check.evidence?.reason, undefined);
});

test('passes the toolchain on a Windows host when adb only reports Running on Windows', async () => {
  const check = await toolchainCheckWithAdbVersion(
    WINDOWS_ADB_VERSION_WITHOUT_INSTALL_PATH,
    'win32',
  );
  assert.equal(check.status, 'pass');
  assert.equal(check.evidence?.reason, undefined);
});
