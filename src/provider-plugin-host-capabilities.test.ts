import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  androidAdbHostTarget,
  androidAdbInvocation,
  androidAdbSerialTarget,
  serializeAndroidAdbInvocation,
  withAndroidHostAdbTransport,
} from '@agent-device/platform-android/mechanics';
import { withCommandHost } from '@agent-device/host-kit/command';
import { createProviderHostCapabilities } from './provider-plugin-host-capabilities.ts';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';

describe('provider host capabilities', () => {
  test('the android facet answers from its supplied host, never the ambient one', async () => {
    const root = mkdtempForTestSync('provider-host-capabilities-');
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const adb = path.join(bin, 'adb');
    writeFileSync(
      adb,
      `#!${process.execPath}\n` +
        `process.stdout.write(JSON.stringify({args:process.argv.slice(2),owner:process.env.CAPABILITY_OWNER}));\n`,
    );
    chmodSync(adb, 0o755);
    const capabilities = await createProviderHostCapabilities({
      env: { ...process.env, PATH: bin, CAPABILITY_OWNER: 'supplied' },
      cwd: root,
    });
    const android = capabilities.android!;
    const invocation = androidAdbInvocation(androidAdbHostTarget(), ['devices']);
    const previous = { PATH: process.env.PATH, CAPABILITY_OWNER: process.env.CAPABILITY_OWNER };
    process.env.PATH = '/usr/bin:/bin';
    process.env.CAPABILITY_OWNER = 'ambient';
    try {
      const standalone = await android.runAdb(invocation, { allowFailure: true });
      const scoped = await withCommandHost(
        {
          host: { env: { ...process.env, PATH: bin, CAPABILITY_OWNER: 'foreign' }, cwd: root },
          requestEnv: { CAPABILITY_OWNER: 'foreign-request' },
        },
        () => android.runAdb(invocation, { allowFailure: true }),
      );
      for (const result of [standalone, scoped]) {
        assert.equal(result.exitCode, 0);
        assert.deepEqual(JSON.parse(result.stdout), { args: ['devices'], owner: 'supplied' });
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('runAdb keeps host-target and serial-target addressing apart on the transport', async () => {
    const { android } = await createProviderHostCapabilities({
      env: process.env,
      cwd: process.cwd(),
    });
    const seen: string[][] = [];
    await withAndroidHostAdbTransport(
      async (invocation) => {
        seen.push([...serializeAndroidAdbInvocation(invocation)]);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async () => {
        await android!.runAdb(androidAdbInvocation(androidAdbHostTarget(), ['kill-server']));
        await android!.runAdb(
          androidAdbInvocation(androidAdbSerialTarget('emulator-5554'), ['disconnect', 'x']),
        );
      },
    );
    expect(seen).toEqual([['kill-server'], ['-s', 'emulator-5554', 'disconnect', 'x']]);
  });

  test('adbError names the invocation through the platform serializer', async () => {
    const { android } = await createProviderHostCapabilities({
      env: process.env,
      cwd: process.cwd(),
    });
    const failure = await android!.adbError(
      'command failed',
      { exitCode: 1, stdout: '', stderr: 'device offline' },
      androidAdbInvocation(androidAdbSerialTarget('127.0.0.1:62001'), ['reverse', 'tcp:8081']),
    );
    expect(failure.details?.command).toBe('adb -s 127.0.0.1:62001 reverse tcp:8081');
    const addressless = await android!.adbError('command failed', {
      exitCode: 1,
      stdout: '',
      stderr: 'no device',
    });
    expect(addressless.details?.command).toBeUndefined();
  });

  test('runShell quotes each word for the device shell and forwards the executor', async () => {
    const { android } = await createProviderHostCapabilities({
      env: process.env,
      cwd: process.cwd(),
    });
    const seen: Array<readonly string[]> = [];
    const result = await android!.runShell(
      async (args) => {
        seen.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      ['am', 'force-stop', 'com.example.app'],
      { allowFailure: true },
    );
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([
      deviceShellArgv('adb', 'shell', ['am', 'force-stop', 'com.example.app']),
    ]);
  });

  test('the apple facet carries the root-composed application tools', async () => {
    const capabilities = await createProviderHostCapabilities({ env: {}, cwd: '/' });
    expect(capabilities.apple?.applicationTools.resolveOpenTarget).toBeTypeOf('function');
  });
});
