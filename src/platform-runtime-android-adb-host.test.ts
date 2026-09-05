import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  createLocalAndroidAdbProvider,
  runAndroidHostAdb,
} from '@agent-device/platform-android/mechanics';
import { mkdtempForTestSync } from './__tests__/test-utils/tmp-dir.ts';
import './platform-runtime-android-adb-host.ts';

test.skipIf(process.platform === 'win32')(
  'the local host binding classifies a real nonzero adb process result',
  async () => {
    const tmpDir = mkdtempForTestSync('agent-device-adb-host-binding-');
    const adbPath = path.join(tmpDir, 'adb');
    fs.writeFileSync(
      adbPath,
      '#!/usr/bin/env node\nprocess.stderr.write("error: device offline\\n"); process.exit(1);',
    );
    fs.chmodSync(adbPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
    try {
      const error = await runAndroidHostAdb(['devices']).then(
        () => assert.fail('expected local adb to reject'),
        (error: unknown) => error,
      );

      assert.ok(error instanceof AppError);
      assert.equal(error.details?.adbFailure, 'device_offline');
      assert.equal(error.details?.retriable, true);
      assert.match(String(error.details?.hint), /adb reconnect/i);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'the root host lowers request-local adb server ports without mutating process env',
  async () => {
    const tmpDir = mkdtempForTestSync('agent-device-adb-server-port-');
    const adbPath = path.join(tmpDir, 'adb');
    fs.writeFileSync(
      adbPath,
      '#!/usr/bin/env node\n' +
        'process.stdout.write(JSON.stringify({args: process.argv.slice(2), port: process.env.ANDROID_ADB_SERVER_PORT ?? null, address: process.env.ANDROID_ADB_SERVER_ADDRESS ?? null}));\n',
    );
    fs.chmodSync(adbPath, 0o755);
    const previousPath = process.env.PATH;
    const previousPort = process.env.ANDROID_ADB_SERVER_PORT;
    process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
    try {
      const provider = createLocalAndroidAdbProvider(
        {
          platform: 'android',
          id: 'emulator-5554',
          name: 'Pixel Emulator',
          kind: 'emulator',
          booted: true,
        },
        { serverPort: 15_037 },
      );
      const adb = provider.exec;
      const serial = JSON.parse((await adb(['shell', 'id'])).stdout) as {
        args: string[];
        port: string | null;
      };
      const serialWithWrongPort = JSON.parse((await adb(['-P', '9999', 'shell', 'id'])).stdout) as {
        args: string[];
        port: string | null;
      };
      const serialWithWrongEnvironment = JSON.parse(
        (
          await adb(['shell', 'id'], {
            env: {
              ANDROID_ADB_SERVER_PORT: '9999',
              ANDROID_ADB_SERVER_ADDRESS: 'foreign.example',
              ADB_SERVER_SOCKET: 'tcp:foreign.example:9999',
            },
          })
        ).stdout,
      ) as { args: string[]; port: string | null };
      const host = JSON.parse(
        (await runAndroidHostAdb(['-P', '9999', 'devices'], { serverPort: 15_038 })).stdout,
      ) as { args: string[]; port: string | null };
      for (const selector of [
        ['-H', 'foreign.example'],
        ['-L', 'tcp:foreign.example:5037'],
        ['-t', '42'],
        ['-s', 'foreign-device'],
        ['-P9999'],
        ['-d'],
        ['-e'],
        ['nodaemon', '-H', 'foreign.example'],
        ['server', '-P', '9999'],
        ['fork-server', '-s', 'foreign-device'],
      ]) {
        await assert.rejects(adb([...selector, 'shell', 'id']), {
          details: { reason: 'managed-device-transport-mismatch' },
        });
        assert.throws(() => provider.spawn?.([...selector, 'shell', 'id']), {
          details: { reason: 'managed-device-transport-mismatch' },
        });
      }

      assert.deepEqual(serial, {
        args: ['-P', '15037', '-s', 'emulator-5554', 'shell', 'id'],
        port: '15037',
        address: '127.0.0.1',
      });
      assert.deepEqual(serialWithWrongPort, serial);
      assert.deepEqual(serialWithWrongEnvironment, serial);
      assert.deepEqual(host, {
        args: ['-P', '15038', 'devices'],
        port: '15038',
        address: '127.0.0.1',
      });
      assert.equal(process.env.ANDROID_ADB_SERVER_PORT, previousPort);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
);
