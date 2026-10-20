import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { withCommandHost } from '@agent-device/host-kit/command';
import { resolveAndroidArchivePackageName } from './artifacts.ts';

test.skipIf(process.platform === 'win32')(
  'standalone artifact resolution uses aapt after an unparseable manifest without poisoning later scoped calls',
  async () => {
    const root = mkdtempForTestSync('agent-device-sdk-artifacts-');
    const sdk = path.join(root, 'sdk');
    const tools = path.join(sdk, 'build-tools', '99.0.0');
    mkdirSync(tools, { recursive: true });
    const manifest = path.join(root, 'AndroidManifest.xml');
    writeFileSync(manifest, '<manifest><application /></manifest>');
    const archive = path.join(root, 'fallback.apk');
    execFileSync('zip', ['-q', archive, 'AndroidManifest.xml'], { cwd: root });
    const calls = path.join(root, 'aapt-calls.jsonl');
    const aapt = path.join(tools, 'aapt');
    writeFileSync(
      aapt,
      `#!${process.execPath}\n` +
        `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');\n` +
        `process.stdout.write("package: name='com.example.fallback' versionCode='1'\\n");\n`,
    );
    chmodSync(aapt, 0o755);
    const previous = {
      ANDROID_HOME: process.env.ANDROID_HOME,
      ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT,
    };
    process.env.ANDROID_HOME = sdk;
    process.env.ANDROID_SDK_ROOT = sdk;
    try {
      const standalone = await resolveAndroidArchivePackageName(archive);
      const scoped = await withCommandHost(
        { host: { env: { ...process.env }, cwd: root }, requestEnv: undefined },
        () => resolveAndroidArchivePackageName(archive),
      );
      assert.deepEqual([standalone, scoped], ['com.example.fallback', 'com.example.fallback']);
      assert.deepEqual(
        readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
        [
          ['dump', 'badging', archive],
          ['dump', 'badging', archive],
        ],
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
