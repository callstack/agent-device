import { expect, test } from 'vitest';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import { installAndroidAdbPackage, pullAndroidAdbFile } from './adb-transfer.ts';
import type { AndroidAdbExecutorResult, AndroidAdbProvider } from './adb-transport.ts';

const ok = (): AndroidAdbExecutorResult => ({ exitCode: 0, stdout: '', stderr: '' });

test('semantic provider methods win over the exec fallback and escape the override scope', async () => {
  let escaped = 0;
  bindAndroidAdbHostStub({
    withoutAdbCommandExecutorOverride: async (fn) => {
      escaped += 1;
      return await fn();
    },
  });
  const pulls: string[][] = [];
  const installs: string[] = [];
  const provider: AndroidAdbProvider = {
    exec: async () => {
      throw new Error('exec fallback must not run when semantic methods exist');
    },
    pull: async (remotePath, localPath) => {
      pulls.push([remotePath, localPath]);
      return ok();
    },
    install: async (apkPath) => {
      installs.push(apkPath);
      return ok();
    },
  };

  await pullAndroidAdbFile('/device/a.apk', '/tmp/a.apk', { provider });
  await installAndroidAdbPackage('/tmp/a.apk', { provider, replace: true });

  expect(pulls).toEqual([['/device/a.apk', '/tmp/a.apk']]);
  expect(installs).toEqual(['/tmp/a.apk']);
  expect(escaped).toBe(2);
});

test('the exec fallback lowers semantic install options into adb flags', async () => {
  bindAndroidAdbHostStub();
  const calls: string[][] = [];
  const provider: AndroidAdbProvider = {
    exec: async (args) => {
      calls.push(args);
      return ok();
    },
  };

  await installAndroidAdbPackage('/tmp/a.apk', {
    provider,
    replace: true,
    allowTestPackages: true,
    allowDowngrade: true,
    grantPermissions: true,
  });
  await pullAndroidAdbFile('/device/a.apk', '/tmp/a.apk', { provider });

  expect(calls).toEqual([
    ['install', '-r', '-t', '-d', '-g', '/tmp/a.apk'],
    ['pull', '/device/a.apk', '/tmp/a.apk'],
  ]);
});

test('transfers without any provider or scope fail closed', async () => {
  bindAndroidAdbHostStub();
  await expect(pullAndroidAdbFile('/device/a.apk', '/tmp/a.apk')).rejects.toThrow(
    /requires an adb provider/,
  );
  await expect(installAndroidAdbPackage('/tmp/a.apk')).rejects.toThrow(/requires an adb provider/);
});
