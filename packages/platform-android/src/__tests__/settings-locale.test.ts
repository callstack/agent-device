import type { DeviceInfo } from '@agent-device/kernel/device';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { setAndroidSetting } from '../settings.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import type { AndroidSnapshotHelperArtifact } from '../snapshot-helper-types.ts';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import { withFakeAdb, type FakeAdbResponse, type FakeAdbScript } from './test-utils/fake-adb.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

const PACKAGE = 'com.callstack.agentdevice.snapshothelper';
const VERSION_CODE = 13003;
const HELPER_BYTES = 'helper-apk';
const APK = `/data/app/~~a1==/${PACKAGE}-b2==/base.apk`;
const PM_PATH = `shell pm path ${PACKAGE}`;
const VERSION_QUERY = `shell cmd package list packages --show-versioncode ${PACKAGE}`;
/** `pm path` lists a split before the base APK, which is the one that holds the helper classes. */
const PM_PATH_OUTPUT = `package:${APK.replace('base.apk', 'split_config.arm64_v8a.apk')}\npackage:${APK}\n`;
const LOCALE_COMMAND_CLASS = `app_process /system/bin ${PACKAGE}.SystemLocaleCommand`;
const LOCALE_COMMAND = `shell env 'CLASSPATH=${APK}' ${LOCALE_COMMAND_CLASS}`;

/** What the device has installed under the helper package name. */
type InstalledHelper = { apkPath: string; versionCode: number; bytes: string };

beforeEach(() => {
  resetAndroidSnapshotHelperInstallCache();
});

/**
 * Runs `settings locale` through the real helper install step against a device whose package
 * manager reports {@link InstalledHelper}, and whose `adb pull` hands back that APK's bytes.
 */
async function withHelperDevice<T>(
  script: FakeAdbScript,
  run: (ctx: {
    calls: (readonly string[])[];
    device: DeviceInfo;
    installed: InstalledHelper;
    pulls: string[];
  }) => Promise<T>,
  options: { installed?: Partial<InstalledHelper>; device?: DeviceInfo } = {},
): Promise<T> {
  const installed: InstalledHelper = {
    apkPath: APK,
    versionCode: VERSION_CODE,
    bytes: HELPER_BYTES,
    ...options.installed,
  };
  const pulls: string[] = [];
  const artifact = await helperArtifact();
  return await withFakeAdb(
    (args, execOptions) => {
      const flat = args.join(' ');
      if (flat === VERSION_QUERY)
        return `package:${PACKAGE} versionCode:${installed.versionCode}\n`;
      if (flat === PM_PATH && installed.apkPath !== APK) return `package:${installed.apkPath}\n`;
      return script(args, execOptions);
    },
    async ({ calls, device }) => await run({ calls, device, installed, pulls }),
    {
      device: options.device,
      provider: {
        snapshotHelperArtifact: artifact,
        pull: async (remotePath, localPath) => {
          pulls.push(remotePath);
          if (remotePath !== installed.apkPath)
            return { stdout: '', stderr: 'no such file', exitCode: 1 };
          await fs.writeFile(localPath, installed.bytes);
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

/** A device whose locale command answers like the helper class: `previous=` and `current=` lines. */
function localeDevice(options: {
  applied?: (requested: string) => string;
  defaultLocale?: string;
}) {
  let current = 'en-US';
  return (args: string[]): FakeAdbResponse => {
    const flat = args.join(' ');
    if (flat === PM_PATH) return PM_PATH_OUTPUT;
    if (flat === 'shell getprop ro.product.locale') return `${options.defaultLocale ?? 'en-US'}\n`;
    if (flat.startsWith(`${LOCALE_COMMAND} `)) {
      const requested = flat.slice(LOCALE_COMMAND.length + 1);
      const previous = current;
      current = options.applied?.(requested) ?? requested;
      return `previous=${previous}\ncurrent=${current}\n`;
    }
    return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
  };
}

function ranAppProcess(calls: (readonly string[])[]): boolean {
  return calls.some((args) => args.join(' ').includes(LOCALE_COMMAND_CLASS));
}

test('settings locale runs the helper class as the shell user and reports the prior locale', async () => {
  await withHelperDevice(localeDevice({}), async ({ calls, device }) => {
    const result = await setAndroidSetting(device, 'locale', 'en-IN');
    expect(result).toEqual({ locale: 'en-IN', previousLocale: 'en-US' });
    expect(calls.map((args) => args.join(' '))).toContain(`${LOCALE_COMMAND} en-IN`);
  });
});

test('settings locale runs through app_process on a physical Android device as well as an emulator', async () => {
  const physical = { ...ANDROID_EMULATOR, id: 'R5CT1234', kind: 'device' as const };
  await withHelperDevice(
    localeDevice({}),
    async ({ calls, device }) => {
      const result = await setAndroidSetting(device, 'locale', 'en-IN');
      expect(result).toEqual({ locale: 'en-IN', previousLocale: 'en-US' });
      expect(calls.map((args) => args.join(' '))).toContain(`${LOCALE_COMMAND} en-IN`);
    },
    { device: physical },
  );
});

test('settings locale reset applies the locale the image boots with', async () => {
  await withHelperDevice(localeDevice({ defaultLocale: 'fr-FR' }), async ({ calls, device }) => {
    expect(await setAndroidSetting(device, 'locale', 'reset')).toMatchObject({ locale: 'fr-FR' });
    expect(calls.map((args) => args.join(' '))).toContain(`${LOCALE_COMMAND} fr-FR`);
  });
});

test('settings locale reset refuses with dispatched no when ro.product.locale is empty', async () => {
  await withHelperDevice(localeDevice({ defaultLocale: '' }), async ({ device }) => {
    await expect(setAndroidSetting(device, 'locale', 'reset')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { dispatched: 'no' },
    });
  });
});

test('settings locale fails with dispatched no when pm path reports no base APK', async () => {
  const script = (args: string[]): FakeAdbResponse => {
    if (args.join(' ') === PM_PATH) return 'package:/data/app/split_config.arm64_v8a.apk\n';
    return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
  };
  // A newer versionCode lets the install step accept the package without reading its path.
  await withHelperDevice(
    script,
    async ({ calls, device }) => {
      await expect(setAndroidSetting(device, 'locale', 'en-IN')).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { reason: 'locale-helper-apk-unverified', dispatched: 'no' },
      });
      expect(ranAppProcess(calls)).toBe(false);
    },
    { installed: { versionCode: VERSION_CODE + 1 } },
  );
});

test('settings locale runs app_process from the base APK whose digest it verified on a cache hit', async () => {
  await withHelperDevice(localeDevice({}), async ({ calls, device, pulls }) => {
    await setAndroidSetting(device, 'locale', 'en-IN');
    const firstCalls = calls.length;
    pulls.length = 0;
    await setAndroidSetting(device, 'locale', 'de-DE');
    const secondCalls = calls.slice(firstCalls).map((args) => args.join(' '));
    // The cached install decision skipped the package manager, yet the APK was still hashed.
    expect(secondCalls).not.toContain(VERSION_QUERY);
    expect(pulls).toEqual([APK]);
    expect(secondCalls).toContain(`${LOCALE_COMMAND} de-DE`);
  });
});

test('settings locale refuses a newer installed helper APK whose digest the manifest does not name', async () => {
  await withHelperDevice(
    localeDevice({}),
    async ({ calls, device }) => {
      await expect(setAndroidSetting(device, 'locale', 'en-IN')).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { reason: 'locale-helper-apk-unverified', dispatched: 'no', apkPath: APK },
      });
      expect(ranAppProcess(calls)).toBe(false);
    },
    { installed: { versionCode: VERSION_CODE + 1, bytes: 'another-apk' } },
  );
});

test('settings locale refuses a helper package replaced after a cached install decision', async () => {
  await withHelperDevice(localeDevice({}), async ({ calls, device, installed }) => {
    await setAndroidSetting(device, 'locale', 'en-IN');
    const firstCalls = calls.length;
    installed.apkPath = `/data/app/~~c3==/${PACKAGE}-d4==/base.apk`;
    installed.bytes = 'another-apk';
    await expect(setAndroidSetting(device, 'locale', 'de-DE')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        reason: 'locale-helper-apk-unverified',
        dispatched: 'no',
        apkPath: installed.apkPath,
      },
    });
    const secondCalls = calls.slice(firstCalls);
    expect(secondCalls.map((args) => args.join(' '))).not.toContain(VERSION_QUERY);
    expect(ranAppProcess(secondCalls)).toBe(false);
  });
});

test('settings locale fails with locale-not-applied when the device keeps another locale', async () => {
  await withHelperDevice(localeDevice({ applied: () => 'en-US' }), async ({ device }) => {
    await expect(setAndroidSetting(device, 'locale', 'de-DE')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'locale-not-applied', dispatched: 'unknown', locale: 'de-DE' },
    });
  });
});

test('settings locale fails when app_process exits non-zero after printing a locale', async () => {
  const script = (args: string[]): FakeAdbResponse => {
    const flat = args.join(' ');
    if (flat === PM_PATH) return PM_PATH_OUTPUT;
    if (flat.startsWith(LOCALE_COMMAND)) {
      return { stdout: 'previous=en-US\ncurrent=de-DE\n', exitCode: 1 };
    }
    return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
  };
  await withHelperDevice(script, async ({ device }) => {
    await expect(setAndroidSetting(device, 'locale', 'de-DE')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { dispatched: 'unknown', exitCode: 1 },
    });
  });
});

test('settings locale surfaces the helper error when the update is refused', async () => {
  const script = (args: string[]): FakeAdbResponse => {
    const flat = args.join(' ');
    if (flat === PM_PATH) return PM_PATH_OUTPUT;
    if (flat.startsWith(LOCALE_COMMAND)) {
      return { stdout: 'error=java.lang.SecurityException: denied\n', exitCode: 1 };
    }
    return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
  };
  await withHelperDevice(script, async ({ device }) => {
    await expect(setAndroidSetting(device, 'locale', 'de-DE')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { dispatched: 'unknown', helperError: 'java.lang.SecurityException: denied' },
    });
  });
});
