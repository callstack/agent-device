import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  createLocalAndroidAdbProvider,
  runAndroidHostAdb,
} from '@agent-device/platform-android/mechanics';
import { ANDROID_EMULATOR } from './__tests__/test-utils/device-fixtures.ts';
import { mkdtempForTestSync } from './__tests__/test-utils/tmp-dir.ts';
import './platform-runtime-android-adb-host.ts';

/**
 * Publishes a fake `adb` on PATH for the duration of `run`. Anything the script needs
 * from the test — a path, a port — arrives through `env`, never spliced into the source
 * the fake is built from.
 */
async function withFakeAdbOnPath<T>(
  scriptBody: string,
  run: () => Promise<T>,
  env: Record<string, string> = {},
): Promise<T> {
  const tmpDir = mkdtempForTestSync('agent-device-adb-host-binding-');
  const adbPath = path.join(tmpDir, 'adb');
  fs.writeFileSync(adbPath, `#!/usr/bin/env node\n${scriptBody}`);
  fs.chmodSync(adbPath, 0o755);
  const previousPath = process.env.PATH;
  const previousEnv = new Map(
    Object.keys(env).map((key) => [key, process.env[key] as string | undefined]),
  );
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await run();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test.skipIf(process.platform === 'win32')(
  'the local host binding classifies a real nonzero adb process result',
  async () => {
    await withFakeAdbOnPath(
      String.raw`process.stderr.write("error: device offline\n"); process.exit(1);`,
      async () => {
        const error = await runAndroidHostAdb(['devices']).then(
          () => assert.fail('expected local adb to reject'),
          (error: unknown) => error,
        );

        assert.ok(error instanceof AppError);
        assert.equal(error.details?.adbFailure, 'device_offline');
        assert.equal(error.details?.retriable, true);
        assert.match(String(error.details?.hint), /adb reconnect/i);
      },
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'the root host lowers request-local adb server ports without mutating process env',
  async () => {
    const previousPort = process.env.ANDROID_ADB_SERVER_PORT;
    const previousSocket = process.env.ADB_SERVER_SOCKET;
    process.env.ADB_SERVER_SOCKET = 'tcp:inherited.example:9999';
    try {
      await withFakeAdbOnPath(
        'process.stdout.write(JSON.stringify({args: process.argv.slice(2), port: process.env.ANDROID_ADB_SERVER_PORT ?? null, address: process.env.ANDROID_ADB_SERVER_ADDRESS ?? null, socket: process.env.ADB_SERVER_SOCKET ?? null}));',
        async () => {
          const provider = createLocalAndroidAdbProvider(ANDROID_EMULATOR, {
            serverPort: 15_037,
          });
          const adb = provider.exec;
          const serial = JSON.parse((await adb(['shell', 'id'])).stdout) as {
            args: string[];
            port: string | null;
          };
          const serialWithWrongPort = JSON.parse(
            (await adb(['-P', '9999', 'shell', 'id'])).stdout,
          ) as { args: string[]; port: string | null };
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
            ['kill-server'],
            ['start-server'],
            ['connect', 'foreign.example'],
            ['disconnect'],
            ['reconnect', 'offline'],
            ['attach', 'foreign-device'],
            ['detach', 'foreign-device'],
            ['pair', 'foreign.example', '123456'],
            ['wait-for-device', 'kill-server'],
            ['wait-for-device', 'disconnect'],
            ['wait-for-any-device', 'pair', 'foreign.example', '123456'],
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
            socket: null,
          });
          assert.deepEqual(serialWithWrongPort, serial);
          assert.deepEqual(serialWithWrongEnvironment, serial);
          const waited = JSON.parse((await adb(['wait-for-device', 'shell', 'id'])).stdout);
          assert.deepEqual(waited, {
            ...serial,
            args: ['-P', '15037', '-s', 'emulator-5554', 'wait-for-device', 'shell', 'id'],
          });
          assert.deepEqual(host, {
            args: ['-P', '15038', 'devices'],
            port: '15038',
            address: '127.0.0.1',
            socket: null,
          });
          assert.equal(process.env.ANDROID_ADB_SERVER_PORT, previousPort);
          assert.equal(process.env.ADB_SERVER_SOCKET, 'tcp:inherited.example:9999');
        },
      );
    } finally {
      if (previousSocket === undefined) delete process.env.ADB_SERVER_SOCKET;
      else process.env.ADB_SERVER_SOCKET = previousSocket;
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'host adb runs in its own process group so a deadline reaches adb fork-server descendants',
  async () => {
    // adb starts a fork-server and talks through it. Killing only the `adb` client
    // leaves that server holding the inherited stdio pipes, so the group-wide kill a
    // `detached` spawn enables is what ends the request.
    const reported = await withFakeAdbOnPath(
      [
        'let ownGroup = false;',
        'try { process.kill(-process.pid, 0); ownGroup = true; } catch {}',
        'process.stdout.write(JSON.stringify({ ownGroup }));',
      ].join('\n'),
      async () => await runAndroidHostAdb(['devices'], { timeoutMs: 3_000 }),
    );

    assert.equal((JSON.parse(reported.stdout) as { ownGroup: boolean }).ownGroup, true);
  },
);

test.skipIf(process.platform === 'win32')(
  'a background adb spawn outlives a timeoutMs that crossed the provider options spread',
  async () => {
    const markerPath = path.join(
      mkdtempForTestSync('agent-device-adb-spawn-deadline-'),
      'helper-session-ended',
    );
    const outcome = await withFakeAdbOnPath(
      [
        'const fs = require("node:fs");',
        'const markerPath = process.env.FAKE_ADB_MARKER_PATH;',
        "setTimeout(() => { fs.writeFileSync(markerPath, 'ended'); }, 250);",
      ].join('\n'),
      async () => {
        const provider = createLocalAndroidAdbProvider(ANDROID_EMULATOR);
        const spawn = provider.spawn;
        if (!spawn) throw new Error('the local adb provider must expose a background spawner');
        // A JavaScript provider or SDK caller can still hand a deadline across this
        // unchecked boundary; the long-lived helper session it lands on must ignore it.
        const leakedOptions = { timeoutMs: 20 } as unknown as NonNullable<
          Parameters<typeof spawn>[1]
        >;
        const child = spawn(['shell', 'logcat'], leakedOptions);
        return await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          child.once('exit', (code, signal) => {
            resolve({ code, signal });
          });
        });
      },
      { FAKE_ADB_MARKER_PATH: markerPath },
    );

    assert.equal(outcome.signal, null);
    assert.equal(outcome.code, 0);
    assert.equal(fs.existsSync(markerPath), true);
  },
);
