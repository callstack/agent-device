import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import {
  applyRuntimeHintValues,
  clearRuntimeHintValues,
} from '../platform-runtime-runtime-hints.ts';
import { applyDeviceDefaultMetroHost, runtimeHintValues } from '../daemon/session-runtime.ts';
import { resolveRuntimeTransportHints } from '../utils/runtime-transport.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  defaultPrefsPath,
  LEGACY_PREFS_PATH,
  withMockedAdb,
  withMockedXcrun,
} from './platform-runtime-runtime-hints.fixtures.ts';

function assertInvalidArgsAppError(error: unknown, message: string): boolean {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'INVALID_ARGS');
  assert.equal(error.message, message);
  return true;
}

test('resolveRuntimeTransportHints derives host, port, and scheme from bundle URL', () => {
  assert.deepEqual(
    resolveRuntimeTransportHints({
      platform: 'android',
      bundleUrl: 'https://10.0.0.10:8082/index.bundle?platform=android',
    }),
    {
      host: '10.0.0.10',
      port: 8082,
      scheme: 'https',
    },
  );
});

test('applyRuntimeHintValues writes debug_http_host to the RN default-preferences file React Native actually reads', async () => {
  await withMockedAdb(async ({ device, argsLogPath, seedPrefsFile, readWrittenPrefsFile }) => {
    const packageName = 'com.example.demo';
    await seedPrefsFile(
      defaultPrefsPath(packageName),
      [
        '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
        '<map>',
        '  <string name="keep_default">default-value</string>',
        '</map>',
        '',
      ].join('\n'),
    );

    await applyRuntimeHintValues({
      device,
      appId: packageName,
      values: {
        bundleUrl: 'https://10.0.0.10:8082/index.bundle?platform=android',
      },
    });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8');
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo cat shared_prefs\/com\.example\.demo_preferences\.xml/,
    );
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo tee shared_prefs\/com\.example\.demo_preferences\.xml/,
    );

    const defaultPayload = await readWrittenPrefsFile(defaultPrefsPath(packageName));
    assert.ok(defaultPayload, 'expected a write to the default RN preferences file');
    assert.match(defaultPayload ?? '', /<string name="keep_default">default-value<\/string>/);
    assert.match(
      defaultPayload ?? '',
      /<string name="debug_http_host">10\.0\.0\.10:8082<\/string>/,
    );
    assert.match(defaultPayload ?? '', /<boolean name="dev_server_https" value="true" \/>/);
  });
});

test('applyRuntimeHintValues also writes the legacy ReactNativeDevPrefs.xml path for back-compat', async () => {
  await withMockedAdb(async ({ device, argsLogPath, seedPrefsFile, readWrittenPrefsFile }) => {
    const packageName = 'com.example.demo';
    await seedPrefsFile(
      LEGACY_PREFS_PATH,
      [
        '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
        '<map>',
        '  <string name="keep_legacy">legacy-value</string>',
        '</map>',
        '',
      ].join('\n'),
    );

    await applyRuntimeHintValues({
      device,
      appId: packageName,
      values: {
        bundleUrl: 'https://10.0.0.10:8082/index.bundle?platform=android',
      },
    });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8');
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo cat shared_prefs\/com\.example\.demo_preferences\.xml/,
    );
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo cat shared_prefs\/ReactNativeDevPrefs\.xml/,
    );
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo tee shared_prefs\/com\.example\.demo_preferences\.xml/,
    );
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo tee shared_prefs\/ReactNativeDevPrefs\.xml/,
    );

    const legacyPayload = await readWrittenPrefsFile(LEGACY_PREFS_PATH);
    assert.ok(legacyPayload, 'expected a write to the legacy ReactNativeDevPrefs.xml file');
    assert.match(legacyPayload ?? '', /<string name="keep_legacy">legacy-value<\/string>/);
    assert.match(legacyPayload ?? '', /<string name="debug_http_host">10\.0\.0\.10:8082<\/string>/);
    assert.match(legacyPayload ?? '', /<boolean name="dev_server_https" value="true" \/>/);
  });
});

test('port-only hint on an Android emulator defaults host to 10.0.2.2 and writes the dev-server pref', async () => {
  await withMockedAdb(async ({ device, readWrittenPrefsFile }) => {
    const packageName = 'com.example.demo';
    const runtime = applyDeviceDefaultMetroHost({ platform: 'android', metroPort: 8084 }, device);
    assert.equal(runtime?.metroHost, '10.0.2.2');

    await applyRuntimeHintValues({
      device,
      appId: packageName,
      values: runtimeHintValues(runtime),
    });

    const defaultPayload = await readWrittenPrefsFile(defaultPrefsPath(packageName));
    assert.ok(defaultPayload, 'expected a write to the default RN preferences file');
    assert.match(defaultPayload ?? '', /<string name="debug_http_host">10\.0\.2\.2:8084<\/string>/);
  });
});

test('Android runtime hints escape XML text and quoted attribute delimiters', async () => {
  await withMockedAdb(async ({ device, readWrittenPrefsFile }) => {
    const packageName = 'com.example.demo';
    await applyRuntimeHintValues({
      device,
      appId: packageName,
      values: {
        metroHost: `host&<>"'`,
        metroPort: '8084',
      },
    });

    const payload = await readWrittenPrefsFile(defaultPrefsPath(packageName));
    assert.ok(payload, 'expected a write to the default RN preferences file');
    assert.match(
      payload ?? '',
      /<string name="debug_http_host">host&amp;&lt;&gt;&quot;&apos;:8084<\/string>/,
    );
  });
});

test('port-only hint on a physical Android device stays ambiguous and writes nothing', async () => {
  await withMockedAdb(async ({ device, argsLogPath, readWrittenPrefsFile }) => {
    const physicalDevice: DeviceInfo = { ...device, id: 'R5CN30', kind: 'device' };
    const runtime = applyDeviceDefaultMetroHost(
      { platform: 'android', metroPort: 8084 },
      physicalDevice,
    );
    assert.equal(runtime?.metroHost, undefined);

    await applyRuntimeHintValues({
      device: physicalDevice,
      appId: 'com.example.demo',
      values: runtimeHintValues(runtime),
    });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8').catch(() => '');
    assert.doesNotMatch(loggedArgs, /tee/);
    assert.equal(await readWrittenPrefsFile(defaultPrefsPath('com.example.demo')), undefined);
  });
});

test('port-only hint on an iOS simulator defaults host to 127.0.0.1', async () => {
  await withMockedXcrun(async ({ device, argsLogPath }) => {
    const runtime = applyDeviceDefaultMetroHost({ platform: 'ios', metroPort: 8084 }, device);
    assert.equal(runtime?.metroHost, '127.0.0.1');

    await applyRuntimeHintValues({
      device,
      appId: 'com.example.demo',
      values: runtimeHintValues(runtime),
    });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8');
    assert.match(
      loggedArgs,
      /simctl spawn sim-1 defaults write com\.example\.demo RCT_jsLocation -string 127\.0\.0\.1:8084/,
    );
  });
});

test('applyRuntimeHintValues rejects Android app binary paths before run-as', async () => {
  await withMockedAdb(async ({ device, argsLogPath }) => {
    await assert.rejects(
      applyRuntimeHintValues({
        device,
        appId: '/tmp/app-debug.apk',
        values: {
          metroHost: '10.0.0.10',
          metroPort: '8081',
        },
      }),
      (error: unknown) =>
        assertInvalidArgsAppError(
          error,
          'Android runtime hints require an installed package name, not "/tmp/app-debug.apk". Install or reinstall the app first, then relaunch by package.',
        ),
    );

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8').catch(() => '');
    assert.equal(loggedArgs, '');
  });
});

test('applyRuntimeHintValues rejects bare Android app binary filenames before run-as', async () => {
  await withMockedAdb(async ({ device, argsLogPath }) => {
    await assert.rejects(
      applyRuntimeHintValues({
        device,
        appId: 'app-debug.apk',
        values: {
          metroHost: '10.0.0.10',
          metroPort: '8081',
        },
      }),
      (error: unknown) =>
        assertInvalidArgsAppError(
          error,
          'Android runtime hints require an installed package name, not "app-debug.apk". Install or reinstall the app first, then relaunch by package.',
        ),
    );

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8').catch(() => '');
    assert.equal(loggedArgs, '');
  });
});

test('applyRuntimeHintValues distinguishes run-as denial from general write failures', async () => {
  await withMockedAdb(async ({ device }) => {
    process.env.AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE = '1';
    process.env.AGENT_DEVICE_TEST_RUN_AS_ID_STDERR =
      'run-as: package not debuggable: com.example.demo';
    try {
      await assert.rejects(
        applyRuntimeHintValues({
          device,
          appId: 'com.example.demo',
          values: {
            metroHost: '10.0.0.10',
            metroPort: '8081',
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to access Android app sandbox for com.example.demo');
          assert.equal(
            error.details?.hint,
            'React Native runtime hints require adb run-as access to the app sandbox. Verify the app is debuggable and the selected package/device are correct.',
          );
          assert.equal(error.details?.exitCode, 1);
          assert.match(String(error.details?.stderr), /not debuggable/);
          return true;
        },
      );
    } finally {
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE;
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_ID_STDERR;
    }
  });
});

test('applyRuntimeHintValues uses generic probe hint when probe fails without run-as denial output', async () => {
  await withMockedAdb(async ({ device }) => {
    process.env.AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE = '1';
    process.env.AGENT_DEVICE_TEST_RUN_AS_ID_STDERR = 'error: device not found';
    try {
      await assert.rejects(
        applyRuntimeHintValues({
          device,
          appId: 'com.example.demo',
          values: {
            metroHost: '10.0.0.10',
            metroPort: '8081',
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to probe Android app sandbox for com.example.demo');
          assert.equal(
            error.details?.hint,
            'adb shell run-as probe failed. Check adb connectivity and that the device is reachable. Inspect stderr/details for more information.',
          );
          assert.equal(error.details?.exitCode, 1);
          assert.match(String(error.details?.stderr), /device not found/);
          return true;
        },
      );
    } finally {
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE;
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_ID_STDERR;
    }
  });
});

test('applyRuntimeHintValues preserves write failures after a successful run-as probe', async () => {
  await withMockedAdb(async ({ device }) => {
    process.env.AGENT_DEVICE_TEST_RUN_AS_WRITE_EXIT_CODE = '1';
    process.env.AGENT_DEVICE_TEST_RUN_AS_WRITE_STDERR =
      "sh: can't create shared_prefs/com.example.demo_preferences.xml: Permission denied";
    try {
      await assert.rejects(
        applyRuntimeHintValues({
          device,
          appId: 'com.example.demo',
          values: {
            metroHost: '10.0.0.10',
            metroPort: '8081',
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to write Android runtime hints for com.example.demo');
          assert.equal(
            error.details?.hint,
            'adb run-as succeeded, but writing React Native dev-server preferences failed. Inspect stderr/details for the failing shell command.',
          );
          assert.equal(error.details?.phase, 'write-runtime-hints');
          assert.equal(error.details?.exitCode, 1);
          assert.match(String(error.details?.stderr), /permission denied/i);
          return true;
        },
      );
    } finally {
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_WRITE_EXIT_CODE;
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_WRITE_STDERR;
    }
  });
});

test('clearRuntimeHintValues removes managed Android runtime prefs from both files but preserves unrelated entries', async () => {
  await withMockedAdb(async ({ device, seedPrefsFile, readWrittenPrefsFile }) => {
    const packageName = 'com.example.demo';
    const seeded = (keepKey: string, keepValue: string): string =>
      [
        '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
        '<map>',
        `  <string name="${keepKey}">${keepValue}</string>`,
        '  <string name="debug_http_host">10.0.0.10:8081</string>',
        '  <boolean name="dev_server_https" value="true" />',
        '</map>',
        '',
      ].join('\n');
    await seedPrefsFile(defaultPrefsPath(packageName), seeded('keep_default', 'default-value'));
    await seedPrefsFile(LEGACY_PREFS_PATH, seeded('keep_legacy', 'legacy-value'));

    await clearRuntimeHintValues({
      device,
      appId: packageName,
    });

    const defaultPayload = await readWrittenPrefsFile(defaultPrefsPath(packageName));
    assert.ok(defaultPayload, 'expected the default RN preferences file to be rewritten');
    assert.match(defaultPayload ?? '', /<string name="keep_default">default-value<\/string>/);
    assert.doesNotMatch(defaultPayload ?? '', /debug_http_host/);
    assert.doesNotMatch(defaultPayload ?? '', /dev_server_https/);

    const legacyPayload = await readWrittenPrefsFile(LEGACY_PREFS_PATH);
    assert.ok(legacyPayload, 'expected the legacy ReactNativeDevPrefs.xml file to be rewritten');
    assert.match(legacyPayload ?? '', /<string name="keep_legacy">legacy-value<\/string>/);
    assert.doesNotMatch(legacyPayload ?? '', /debug_http_host/);
    assert.doesNotMatch(legacyPayload ?? '', /dev_server_https/);
  });
});

test('applyRuntimeHintValues writes iOS simulator React Native defaults', async () => {
  await withMockedXcrun(async ({ device, argsLogPath }) => {
    await applyRuntimeHintValues({
      device,
      appId: 'com.example.demo',
      values: {
        metroHost: '127.0.0.1',
        metroPort: '8081',
      },
    });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8');
    assert.match(
      loggedArgs,
      /simctl spawn sim-1 defaults write com\.example\.demo RCT_jsLocation -string 127\.0\.0\.1:8081/,
    );
    assert.match(
      loggedArgs,
      /simctl spawn sim-1 defaults write com\.example\.demo RCT_packager_scheme -string http/,
    );
  });
});

test('clearRuntimeHintValues deletes iOS simulator React Native defaults', async () => {
  await withMockedXcrun(async ({ device, argsLogPath }) => {
    await clearRuntimeHintValues({
      device,
      appId: 'com.example.demo',
    });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8');
    assert.match(
      loggedArgs,
      /simctl spawn sim-1 defaults delete com\.example\.demo RCT_jsLocation/,
    );
    assert.match(
      loggedArgs,
      /simctl spawn sim-1 defaults delete com\.example\.demo RCT_packager_scheme/,
    );
  });
});
