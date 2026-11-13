import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { withCommandHost } from '@agent-device/host-kit/command';
import { resolveAndroidArchivePackageName } from './artifacts.ts';

test.skipIf(process.platform === 'win32')(
  'public artifact resolution keeps each concurrent caller SDK and environment',
  async () => {
    const root = mkdtempForTestSync('agent-device-sdk-artifacts-');
    writeFileSync(path.join(root, 'AndroidManifest.xml'), '<manifest><application /></manifest>');
    const archive = path.join(root, 'fallback.apk');
    execFileSync('zip', ['-q', archive, 'AndroidManifest.xml'], { cwd: root });
    const host = (owner: string) => {
      const sdk = path.join(root, owner);
      const tools = path.join(sdk, 'build-tools', '99.0.0');
      mkdirSync(tools, { recursive: true });
      const aapt = path.join(tools, 'aapt');
      writeFileSync(
        aapt,
        `#!${process.execPath}\nprocess.stdout.write("package: name='com.example.${owner}' versionCode='1'\\n");`,
      );
      chmodSync(aapt, 0o755);
      return {
        env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, PATH: process.env.PATH },
        cwd: root,
      };
    };
    const first = host('first');
    const second = host('second');
    assert.equal(
      await resolveAndroidArchivePackageName(path.basename(archive), first),
      'com.example.first',
    );
    const result = await withCommandHost({ host: host('foreign'), requestEnv: undefined }, () =>
      Promise.all([
        resolveAndroidArchivePackageName(path.basename(archive), first),
        resolveAndroidArchivePackageName(path.basename(archive), second),
      ]),
    );
    assert.deepEqual(result, ['com.example.first', 'com.example.second']);
  },
);
