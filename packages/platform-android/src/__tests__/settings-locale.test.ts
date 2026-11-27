import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { beforeEach, expect, test } from 'vitest';
import { setAndroidSetting } from '../settings.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import type { AndroidSnapshotHelperArtifact } from '../snapshot-helper-types.ts';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import { withFakeAdb, type FakeAdbResponse } from './test-utils/fake-adb.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

const PACKAGE = 'com.callstack.agentdevice.snapshothelper';
const VERSION_CODE = 13003;
const HELPER_BYTES = 'helper-apk';
const APK = `/data/app/~~a1==/${PACKAGE}-b2==/base.apk`;
const VERSION_QUERY = `shell cmd package list packages --show-versioncode ${PACKAGE}`;
const LOCALE_COMMAND =
  /^shell env '?CLASSPATH=([^'\s]+)'? app_process \/system\/bin \S+\.SystemLocaleCommand (\S+)$/;
const STAGED_APK = /^\/data\/local\/tmp\/agent-device-locale-[0-9a-f]{16}\.apk$/;

/** The helper package the device reports, and the files its shell can copy and adb can pull. */
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
 * manager reports {@link HelperDevice}, its shell copies and removes files, `adb pull` reads them,
 * and `app_process` answers like the helper class with `previous=` and `current=` lines.
 */
async function withHelperDevice<T>(
  run: (ctx: {
    calls: (readonly string[])[];
    device: DeviceInfo;
    helper: HelperDevice;
  }) => Promise<T>,
  options: {
    versionCode?: number | undefined;
    bytes?: string;
    /** The bytes a helper install leaves at the base APK path. */
    installs?: string;
    defaultLocale?: string;
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
      const words = args.map((word) => word.replace(/^'(.*)'$/, '$1'));
      if (flat === VERSION_QUERY) {
        return helper.versionCode === undefined
          ? { stderr: '', exitCode: 1 }
          : `package:${PACKAGE} versionCode:${helper.versionCode}\n`;
      }
      if (flat === `shell pm path ${PACKAGE}`) {
        // A split comes first: only the base APK holds the helper classes.
        return `package:${helper.apkPath.replace('base.apk', 'split_config.arm64_v8a.apk')}\npackage:${helper.apkPath}\n`;
      }
      if (flat === 'shell getprop ro.product.locale')
        return `${options.defaultLocale ?? 'en-US'}\n`;
      if (words[1] === 'cp' && words.length === 4) {
        const bytes = helper.files.get(words[2]!);
        if (bytes === undefined) return { stderr: `cp: ${words[2]}: No such file`, exitCode: 1 };
        helper.files.set(words[3]!, bytes);
        return '';
      }
      if (words[1] === 'rm' && words[2] === '-f' && words.length === 4) {
        helper.files.delete(words[3]!);
        return '';
      }
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
    async ({ calls, device }) => await run({ calls, device, helper }),
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

test('settings locale runs app_process from the staged copy whose digest it verified on a cache hit', async () => {
  await withHelperDevice(async ({ calls, device, helper }) => {
    await setAndroidSetting(device, 'locale', 'en-IN');
    const firstCalls = calls.length;
    helper.pulls.length = 0;
    await setAndroidSetting(device, 'locale', 'de-DE');
    // The cached install decision skipped the package manager, yet the staged copy was hashed.
    expect(calls.slice(firstCalls).map((args) => args.join(' '))).not.toContain(VERSION_QUERY);
    const launched = helper.launches.at(-1);
    expect(launched).toMatch(STAGED_APK);
    expect(helper.pulls).toEqual([launched]);
    expect([...helper.files.keys()]).toEqual([APK]);
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
          installedApkPath: APK,
        },
      });
      expect(helper.launches).toEqual([]);
      expect([...helper.files.keys()]).toEqual([APK]);
    },
    { versionCode: VERSION_CODE + 1, bytes: 'another-apk' },
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
        installedApkPath: helper.apkPath,
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

test('settings locale keeps the adb failure when the staged copy cannot be pulled', async () => {
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
      // The copy reports success but writes nothing, so the pull finds no staged file.
      override: (args) => (args[1] === 'cp' ? '' : undefined),
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
