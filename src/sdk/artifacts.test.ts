import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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

test.skipIf(process.platform === 'win32').each(['manifest', 'aapt'] as const)(
  'public archive inspection runs %s tools in the supplied cwd with a relative PATH',
  async (source) => {
    const root = realpathSync(mkdtempForTestSync('agent-device-sdk-archive-cwd-'));
    const bin = path.join(root, 'bin');
    const sdk = path.join(root, 'sdk');
    const tools = path.join(sdk, 'build-tools', '99.0.0');
    mkdirSync(bin);
    mkdirSync(tools, { recursive: true });
    const unzip = path.join(bin, 'unzip');
    const aapt = path.join(tools, 'aapt');
    const cwdGuard = `if(process.cwd()!==${JSON.stringify(root)})process.exit(2);`;
    writeFileSync(
      unzip,
      `#!${process.execPath}\n${cwdGuard}${
        source === 'manifest'
          ? `process.stdout.write('<manifest package="com.example.manifest"/>');`
          : 'process.exit(1);'
      }`,
    );
    writeFileSync(
      aapt,
      `#!${process.execPath}\n${cwdGuard}process.stdout.write("package: name='com.example.aapt' versionCode='1'\\n");`,
    );
    chmodSync(unzip, 0o755);
    chmodSync(aapt, 0o755);
    const archive = path.join(root, 'app.apk');
    writeFileSync(archive, 'archive fixture');
    assert.equal(
      await resolveAndroidArchivePackageName(archive, {
        cwd: root,
        env: { PATH: './bin', ANDROID_SDK_ROOT: sdk },
      }),
      `com.example.${source}`,
    );
  },
);
