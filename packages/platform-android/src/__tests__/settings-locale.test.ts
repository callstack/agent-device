import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { beforeEach, expect, test, vi } from 'vitest';
import { prepareAndroidAutomationHelper } from '../automation-helper-artifact.ts';
import { setAndroidSetting } from '../settings.ts';
import {
  ensureAndroidSnapshotHelper,
  resetAndroidSnapshotHelperInstallCache,
} from '../snapshot-helper-install.ts';
import type { AndroidSnapshotHelperArtifact } from '../snapshot-helper-types.ts';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import { withFakeAdb, type FakeAdbResponse } from './test-utils/fake-adb.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

vi.mock('../automation-helper-artifact.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../automation-helper-artifact.ts')>();
  return {
    ...actual,
    prepareAndroidAutomationHelper: vi.fn(actual.prepareAndroidAutomationHelper),
  };
});

const PACKAGE = 'com.callstack.agentdevice.snapshothelper';
const VERSION_CODE = 13003;
const HELPER_BYTES = 'helper-apk';
const APK = `/data/app/~~a1==/${PACKAGE}-b2==/base.apk`;
const VERSION_QUERY = `shell cmd package list packages --show-versioncode ${PACKAGE}`;
const LOCALE_COMMAND =
  /^shell env '?CLASSPATH=([^'\s]+)'? app_process \/system\/bin \S+\.SystemLocaleCommand (\S+)$/;

/** The helper package the device reports, and the files adb can pull. */
type HelperDevice = {
  apkPath: string;
  /** Undefined while no package is installed under the helper name. */
  versionCode: number | undefined;
  files: Map<string, string>;
  /** The CLASSPATH of every `app_process` launch, in order. */
  launches: string[];
  pulls: string[];
};

/** An answer for one adb call, or undefined to let the fake device answer it. */
type Override = (args: string[], device: HelperDevice) => FakeAdbResponse | undefined;

beforeEach(() => {
  resetAndroidSnapshotHelperInstallCache();
});

/**
 * Runs `settings locale` through the real helper install step against a fake device. Its package
 * manager reports {@link HelperDevice}, `adb pull` reads its files,
 * and `app_process` answers like the helper class with `previous=` and `current=` lines.
 */
async function withHelperDevice<T>(
  run: (ctx: {
    calls: (readonly string[])[];
    device: DeviceInfo;
    helper: HelperDevice;
    artifact: AndroidSnapshotHelperArtifact;
  }) => Promise<T>,
  options: {
    versionCode?: number | undefined;
    bytes?: string;
    /** The bytes a helper install leaves at the base APK path. */
    installs?: string;
    defaultLocale?: string;
    sdkInt?: number;
    applied?: (requested: string) => string;
    override?: Override;
    device?: DeviceInfo;
  } = {},
): Promise<T> {
  const helper: HelperDevice = {
    apkPath: APK,
    versionCode: 'versionCode' in options ? options.versionCode : VERSION_CODE,
    files: new Map([[APK, options.bytes ?? HELPER_BYTES]]),
    launches: [],
    pulls: [],
  };
  let current = 'en-US';
  const artifact = await helperArtifact();
  return await withFakeAdb(
    (args) => {
      const overridden = options.override?.(args, helper);
      if (overridden !== undefined) return overridden;
      const flat = args.join(' ');
      if (flat === VERSION_QUERY) {
        return helper.versionCode === undefined
          ? { stderr: '', exitCode: 1 }
          : `package:${PACKAGE} versionCode:${helper.versionCode}\n`;
      }
      if (flat === `shell pm path ${PACKAGE}`) {
        // A split comes first: only the base APK holds the helper classes.
        return `package:${helper.apkPath.replace('base.apk', 'split_config.arm64_v8a.apk')}\npackage:${helper.apkPath}\n`;
      }
      if (flat === 'shell getprop ro.build.version.sdk') return `${options.sdkInt ?? 36}\n`;
      if (flat === 'shell getprop ro.product.locale')
        return `${options.defaultLocale ?? 'en-US'}\n`;
      const launch = LOCALE_COMMAND.exec(flat);
      if (launch) {
        helper.launches.push(launch[1]!);
        if (helper.files.get(launch[1]!) !== HELPER_BYTES) {
          return { stdout: 'error=ClassNotFoundException\n', exitCode: 1 };
        }
        const previous = current;
        current = options.applied?.(launch[2]!) ?? launch[2]!;
        return `previous=${previous}\ncurrent=${current}\n`;
      }
      return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
    },
    async ({ calls, device }) => await run({ calls, device, helper, artifact }),
    {
      device: options.device,
      provider: {
        snapshotHelperArtifact: artifact,
        install: async () => {
          helper.versionCode = VERSION_CODE;
          helper.files.set(helper.apkPath, options.installs ?? HELPER_BYTES);
          return { stdout: 'Success', stderr: '', exitCode: 0 };
        },
        pull: async (remotePath, localPath) => {
          helper.pulls.push(remotePath);
          const bytes = helper.files.get(remotePath);
          if (bytes === undefined) return { stdout: '', stderr: 'no such file', exitCode: 1 };
          await fs.writeFile(localPath, bytes);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    },
  );
}

async function helperArtifact(): Promise<AndroidSnapshotHelperArtifact> {
  const apkPath = path.join(await mkdtempForTest('settings-locale-helper-'), 'helper.apk');
  await fs.writeFile(apkPath, HELPER_BYTES);
  return {
    apkPath,
    manifest: {
      name: 'android-snapshot-helper',
      version: '0.13.3',
      apkUrl: null,
      sha256: crypto.createHash('sha256').update(HELPER_BYTES).digest('hex'),
      packageName: PACKAGE,
      versionCode: VERSION_CODE,
      instrumentationRunner: `${PACKAGE}/.SnapshotInstrumentation`,
      minSdk: 23,
      outputFormat: 'uiautomator-xml',
      statusProtocol: 'android-snapshot-helper-v1',
    },
  };
}

test('settings locale runs the helper class as the shell user and reports the prior locale', async () => {
  await withHelperDevice(async ({ device, helper }) => {
    const result = await setAndroidSetting(device, 'locale', 'en-IN');
    expect(result).toEqual({ locale: 'en-IN', previousLocale: 'en-US' });
    expect(helper.launches).toHaveLength(1);
  });
});

test('settings locale runs through app_process on a physical Android device as well as an emulator', async () => {
  const physical = { ...ANDROID_EMULATOR, id: 'R5CT1234', kind: 'device' as const };
  await withHelperDevice(
    async ({ device, helper }) => {
      const result = await setAndroidSetting(device, 'locale', 'en-IN');
      expect(result).toEqual({ locale: 'en-IN', previousLocale: 'en-US' });
      expect(helper.launches).toHaveLength(1);
    },
    { device: physical },
  );
});

test('settings locale reset applies the locale the image boots with', async () => {
  await withHelperDevice(
    async ({ device }) => {
      expect(await setAndroidSetting(device, 'locale', 'reset')).toMatchObject({ locale: 'fr-FR' });
    },
    { defaultLocale: 'fr-FR' },
  );
});

test('settings locale reset refuses with dispatched no when ro.product.locale is empty', async () => {
  await withHelperDevice(
    async ({ device }) => {
      await expect(setAndroidSetting(device, 'locale', 'reset')).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { dispatched: 'no' },
      });
    },
    { defaultLocale: '' },
  );
});

test('settings locale runs app_process from the base APK whose digest it verified on a cache hit', async () => {
  await withHelperDevice(async ({ calls, device, helper }) => {
    await setAndroidSetting(device, 'locale', 'en-IN');
    const firstCalls = calls.length;
    helper.pulls.length = 0;
    await setAndroidSetting(device, 'locale', 'de-DE');
    // The cached install decision skipped the package manager, yet the base APK was hashed.
    expect(calls.slice(firstCalls).map((args) => args.join(' '))).not.toContain(VERSION_QUERY);
    expect(helper.pulls).toEqual([APK]);
    expect(helper.launches).toEqual([APK, APK]);
  });
});

test('settings locale refuses a newer installed helper APK whose digest the manifest does not name', async () => {
  await withHelperDevice(
    async ({ device, helper }) => {
      await expect(setAndroidSetting(device, 'locale', 'en-IN')).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: {
          reason: 'locale-helper-apk-unverified',
          dispatched: 'no',
          apkPath: APK,
        },
      });
      expect(helper.launches).toEqual([]);
    },
    { versionCode: VERSION_CODE + 1, bytes: 'another-apk' },
  );
});

test('a locale refusal keeps the snapshot install memo and makes the next locale call inspect the install', async () => {
  await withHelperDevice(
    async ({ calls, device, helper, artifact }) => {
      await expect(setAndroidSetting(device, 'locale', 'en-IN')).rejects.toMatchObject({
        details: { reason: 'locale-helper-apk-unverified' },
      });

      // The snapshot install step answers from its memo without touching the device.
      const snapshotCalls: (readonly string[])[] = [];
      const install = await ensureAndroidSnapshotHelper({
        adb: async (args) => {
          snapshotCalls.push(args);
          return { stdout: '', stderr: 'unexpected', exitCode: 1 };
        },
        artifact,
        deviceKey: `android:${device.id}`,
      });
      expect(install).toMatchObject({ reason: 'current', installed: false });
      expect(snapshotCalls).toEqual([]);

      const firstCall = calls.length;
      await expect(setAndroidSetting(device, 'locale', 'en-IN')).rejects.toMatchObject({
        details: { reason: 'locale-helper-apk-unverified' },
      });
      expect(calls.slice(firstCall).map((args) => args.join(' '))).toContain(VERSION_QUERY);
      expect(helper.launches).toEqual([]);
    },
    { versionCode: VERSION_CODE + 1, bytes: 'another-apk' },
  );
});

test('a locale call that saw no refusal keeps a refusal recorded while it prepared the helper', async () => {
  let pmPathFails = false;
  await withHelperDevice(
    async ({ calls, device, helper }) => {
      await setAndroidSetting(device, 'locale', 'en-IN');
      // A same-version APK with another digest replaces the helper behind the warm memo.
      helper.files.set(APK, 'another-apk');

      // Call A reads no refusal, then waits inside helper preparation.
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => (resume = resolve));
      let entered!: () => void;
      const preparing = new Promise<void>((resolve) => (entered = resolve));
      const actual = vi.mocked(prepareAndroidAutomationHelper).getMockImplementation()!;
      vi.mocked(prepareAndroidAutomationHelper).mockImplementationOnce(async (...args) => {
        entered();
        await paused;
        return await actual(...args);
      });
      const callA = setAndroidSetting(device, 'locale', 'de-DE');
      await preparing;

      // Call B refuses the APK and records a recheck.
      await expect(setAndroidSetting(device, 'locale', 'de-DE')).rejects.toMatchObject({
        details: { reason: 'locale-helper-apk-unverified' },
      });

      // Call A resumes and fails on the transport, so it answers no refusal.
      pmPathFails = true;
      resume();
      await expect(callA).rejects.toMatchObject({ details: { adbFailure: 'device_offline' } });
      pmPathFails = false;

      // The next locale call still inspects the install, which reinstalls the helper.
      const firstCall = calls.length;
      await expect(setAndroidSetting(device, 'locale', 'de-DE')).resolves.toMatchObject({
        locale: 'de-DE',
      });
      expect(calls.slice(firstCall).map((args) => args.join(' '))).toContain(VERSION_QUERY);
    },
    {
      override: (args) =>
        pmPathFails && args.join(' ') === `shell pm path ${PACKAGE}`
          ? { stderr: 'error: device offline', exitCode: 1 }
          : undefined,
    },
  );
});

test('settings locale refuses a helper package replaced after a cached install decision, then rechecks it', async () => {
  await withHelperDevice(async ({ calls, device, helper }) => {
    await setAndroidSetting(device, 'locale', 'en-IN');
    let firstCall = calls.length;
    helper.apkPath = `/data/app/~~c3==/${PACKAGE}-d4==/base.apk`;
    helper.files.set(helper.apkPath, 'another-apk');
    await expect(setAndroidSetting(device, 'locale', 'de-DE')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        reason: 'locale-helper-apk-unverified',
        dispatched: 'no',
        apkPath: helper.apkPath,
      },
    });
    expect(calls.slice(firstCall).map((args) => args.join(' '))).not.toContain(VERSION_QUERY);
    expect(helper.launches).toHaveLength(1);

    // The genuine helper is back; the next locale command inspects the package again.
    helper.files.set(helper.apkPath, HELPER_BYTES);
    firstCall = calls.length;
    await setAndroidSetting(device, 'locale', 'de-DE');
    expect(calls.slice(firstCall).map((args) => args.join(' '))).toContain(VERSION_QUERY);
    expect(helper.launches).toHaveLength(2);
  });
});

test('settings locale refuses Android before 8.0 before it prepares the helper', async () => {
  await withHelperDevice(
    async ({ calls, device, helper }) => {
      await expect(setAndroidSetting(device, 'locale', 'en-IN')).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
        details: { reason: 'locale-api-level-unsupported', dispatched: 'no', sdkInt: 25 },
      });
      expect(calls.map((args) => args.join(' '))).toEqual(['shell getprop ro.build.version.sdk']);
      expect(helper.launches).toEqual([]);
    },
    { sdkInt: 25 },
  );
});

test('settings locale names the helper install it completed before a refusal', async () => {
  await withHelperDevice(
    async ({ device, helper }) => {
      await expect(setAndroidSetting(device, 'locale', 'en-IN')).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: {
          reason: 'locale-helper-apk-unverified',
          dispatched: 'no',
          helperInstalled: true,
          helperInstallReason: 'missing',
        },
      });
      expect(helper.launches).toEqual([]);
    },
    // The package is swapped right after the install lands.
    { versionCode: undefined, installs: 'another-apk' },
  );
});

test('settings locale refuses with dispatched no when pm path reports no base APK', async () => {
  await withHelperDevice(
    async ({ device, helper }) => {
      await expect(setAndroidSetting(device, 'locale', 'en-IN')).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { reason: 'locale-helper-apk-unverified', dispatched: 'no' },
      });
      expect(helper.launches).toEqual([]);
    },
    {
      // A newer versionCode lets the install step accept the package without reading its path.
      versionCode: VERSION_CODE + 1,
      override: (args) =>
        args.join(' ') === `shell pm path ${PACKAGE}`
          ? 'package:/data/app/split_config.arm64_v8a.apk\n'
          : undefined,
    },
  );
});

test('settings locale keeps the adb classification when pm path fails on the transport', async () => {
  await withHelperDevice(
    async ({ device, helper }) => {
      const failure = setAndroidSetting(device, 'locale', 'en-IN');
      await expect(failure).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: {
          adbFailure: 'device_offline',
          dispatched: 'no',
          stderr: 'error: device offline',
        },
      });
      await expect(failure).rejects.not.toMatchObject({
        details: { reason: 'locale-helper-apk-unverified' },
      });
      expect(helper.launches).toEqual([]);
    },
    {
      versionCode: VERSION_CODE + 1,
      override: (args) =>
        args.join(' ') === `shell pm path ${PACKAGE}`
          ? { stderr: 'error: device offline', exitCode: 1 }
          : undefined,
    },
  );
});

test('settings locale keeps the adb failure when the base APK cannot be pulled', async () => {
  await withHelperDevice(
    async ({ device, helper }) => {
      const failure = setAndroidSetting(device, 'locale', 'en-IN');
      await expect(failure).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { dispatched: 'no', exitCode: 1, stderr: 'no such file' },
      });
      await expect(failure).rejects.not.toMatchObject({
        details: { reason: 'locale-helper-apk-unverified' },
      });
      expect(helper.launches).toEqual([]);
    },
    {
      versionCode: VERSION_CODE + 1,
      // `pm path` names a base APK that the pull cannot read.
      override: (args) =>
        args.join(' ') === `shell pm path ${PACKAGE}`
          ? `package:/data/app/~~e5==/${PACKAGE}-f6==/base.apk\n`
          : undefined,
    },
  );
});

test('settings locale fails with locale-not-applied when the device keeps another locale', async () => {
  await withHelperDevice(
    async ({ device }) => {
      await expect(setAndroidSetting(device, 'locale', 'de-DE')).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { reason: 'locale-not-applied', dispatched: 'unknown', locale: 'de-DE' },
      });
    },
    { applied: () => 'en-US' },
  );
});

test('settings locale fails when app_process exits non-zero after printing a locale', async () => {
  await withHelperDevice(
    async ({ device }) => {
      await expect(setAndroidSetting(device, 'locale', 'de-DE')).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { dispatched: 'unknown', exitCode: 1 },
      });
    },
    {
      override: (args) =>
        LOCALE_COMMAND.test(args.join(' '))
          ? { stdout: 'previous=en-US\ncurrent=de-DE\n', exitCode: 1 }
          : undefined,
    },
  );
});

test('settings locale surfaces the helper error when the update is refused', async () => {
  await withHelperDevice(
    async ({ device }) => {
      await expect(setAndroidSetting(device, 'locale', 'de-DE')).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { dispatched: 'unknown', helperError: 'java.lang.SecurityException: denied' },
      });
    },
    {
      override: (args) =>
        LOCALE_COMMAND.test(args.join(' '))
          ? { stdout: 'error=java.lang.SecurityException: denied\n', exitCode: 1 }
          : undefined,
    },
  );
});
