import { expect, test, vi } from 'vitest';
import { setAndroidSetting } from '../settings.ts';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import { withFakeAdb, type FakeAdbResponse } from './test-utils/fake-adb.ts';

vi.mock('../automation-helper-artifact.ts', () => ({
  prepareAndroidAutomationHelper: vi.fn(async () => ({
    artifact: { manifest: { packageName: 'com.callstack.agentdevice.snapshothelper' } },
  })),
}));

const APK = '/data/app/~~a1==/com.callstack.agentdevice.snapshothelper-b2==/base.apk';
const PM_PATH = 'shell pm path com.callstack.agentdevice.snapshothelper';
/** `pm path` lists a split before the base APK, which is the one that holds the helper classes. */
const PM_PATH_OUTPUT = `package:${APK.replace('base.apk', 'split_config.arm64_v8a.apk')}\npackage:${APK}\n`;
const LOCALE_COMMAND = `shell env 'CLASSPATH=${APK}' app_process /system/bin com.callstack.agentdevice.snapshothelper.SystemLocaleCommand`;

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

test('settings locale runs the helper class as the shell user and reports the prior locale', async () => {
  await withFakeAdb(localeDevice({}), async ({ calls, device }) => {
    const result = await setAndroidSetting(device, 'locale', 'en-IN');
    expect(result).toEqual({ locale: 'en-IN', previousLocale: 'en-US' });
    expect(calls.map((args) => args.join(' '))).toContain(`${LOCALE_COMMAND} en-IN`);
  });
});

test('settings locale runs through app_process on a physical Android device as well as an emulator', async () => {
  const physical = { ...ANDROID_EMULATOR, id: 'R5CT1234', kind: 'device' as const };
  await withFakeAdb(
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
  await withFakeAdb(localeDevice({ defaultLocale: 'fr-FR' }), async ({ calls, device }) => {
    expect(await setAndroidSetting(device, 'locale', 'reset')).toMatchObject({ locale: 'fr-FR' });
    expect(calls.map((args) => args.join(' '))).toContain(`${LOCALE_COMMAND} fr-FR`);
  });
});

test('settings locale reset refuses with dispatched no when ro.product.locale is empty', async () => {
  await withFakeAdb(localeDevice({ defaultLocale: '' }), async ({ device }) => {
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
  await withFakeAdb(script, async ({ device }) => {
    await expect(setAndroidSetting(device, 'locale', 'en-IN')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { dispatched: 'no' },
    });
  });
});

test('settings locale fails with locale-not-applied when the device keeps another locale', async () => {
  await withFakeAdb(localeDevice({ applied: () => 'en-US' }), async ({ device }) => {
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
  await withFakeAdb(script, async ({ device }) => {
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
  await withFakeAdb(script, async ({ device }) => {
    await expect(setAndroidSetting(device, 'locale', 'de-DE')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { dispatched: 'unknown', helperError: 'java.lang.SecurityException: denied' },
    });
  });
});
