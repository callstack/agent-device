import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { runCmd } from '../../../utils/exec.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel Emulator',
  kind: 'emulator',
  booted: true,
} as const;

test('withAndroidAdbProvider intercepts adb commands for the scoped serial', async () => {
  const calls: string[][] = [];

  const result = await withAndroidAdbProvider(
    async (args, options) => {
      calls.push(args);
      return {
        stdout: options?.allowFailure ? 'allowed' : 'ok',
        stderr: '',
        exitCode: 0,
      };
    },
    { serial: device.id },
    async () =>
      await runCmd('adb', ['-s', 'emulator-5554', 'shell', 'echo', 'ok'], {
        allowFailure: true,
      }),
  );

  assert.equal(result.stdout, 'allowed');
  assert.deepEqual(calls, [['shell', 'echo', 'ok']]);
});

test('withAndroidAdbProvider ignores adb commands for another serial', async () => {
  const calls: string[][] = [];
  const tmpDir = mkdtempForTestSync('agent-device-adb-provider-scope-');
  const adbPath = path.join(tmpDir, 'adb');
  fs.writeFileSync(
    adbPath,
    '#!/usr/bin/env node\nprocess.stdout.write(`local ${process.argv.slice(2).join(" ")}`);',
  );
  fs.chmodSync(adbPath, 0o755);

  const result = await withAndroidAdbProvider(
    async (args) => {
      calls.push(args);
      return { stdout: 'provider', stderr: '', exitCode: 0 };
    },
    { serial: device.id },
    async () =>
      await runCmd('adb', ['-s', 'other-device', 'shell', 'echo', 'local'], {
        allowFailure: true,
        env: { ...process.env, PATH: `${tmpDir}${path.delimiter}${process.env.PATH ?? ''}` },
      }),
  );

  assert.equal(result.stdout, 'local -s other-device shell echo local');
  assert.deepEqual(calls, []);
});
