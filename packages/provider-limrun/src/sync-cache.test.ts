import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { LimrunSyncCache } from './sync-cache.ts';

test('materializations reuse one basis, prune removed resources, and release it with the lease', async () => {
  const root = await mkdtempForTest('limrun-sync-test-');
  const cache = new LimrunSyncCache();
  let basis = '';
  for (const version of ['first', 'second']) {
    const app = path.join(root, version, 'Example.app');
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(app, 'Executable'), version);
    await cache.run(app, 'ios', async (directory) => {
      if (basis) {
        expect(directory).toBe(basis);
        expect(await fs.readFile(path.join(directory, 'Executable'), 'utf8')).toBe('first');
      }
      basis = directory;
      await fs.writeFile(path.join(directory, 'Executable'), version);
      await fs.writeFile(path.join(directory, 'removed-resource'), 'old');
    });
    expect(await fs.readdir(basis)).toEqual(['Executable']);
  }
  await cache.dispose();
  await expect(fs.stat(basis)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(cache.run(root, 'ios', async () => {})).rejects.toMatchObject({
    details: { reason: 'limrun_app_sync_retired' },
  });
});

test('cache teardown waits for serialized APK syncs to finish reading their basis', async () => {
  const root = await mkdtempForTest('limrun-sync-test-');
  const apk = path.join(root, 'Example.apk');
  await fs.writeFile(apk, 'apk');
  const cache = new LimrunSyncCache();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let basis = '';
  const first = cache.run(apk, 'android', async (directory) => {
    basis = directory;
    await fs.copyFile(apk, path.join(directory, 'Example.apk'));
    started();
    await hold;
    expect(await fs.readFile(path.join(directory, 'Example.apk'), 'utf8')).toBe('apk');
  });
  await entered;
  let secondRan = false;
  const second = cache.run(apk, 'android', async (directory) => {
    expect(await fs.readFile(path.join(directory, 'Example.apk'), 'utf8')).toBe('apk');
    secondRan = true;
  });
  const disposal = cache.dispose();
  expect(secondRan).toBe(false);
  release();
  await Promise.all([first, second, disposal]);
  expect(secondRan).toBe(true);
  await expect(fs.stat(basis)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each([new Error('SDK refused sync'), new AppError('INVALID_ARGS', 'invalid input')])(
  'sync failures preserve typed errors or wrap the SDK cause and clear partial basis',
  async (cause) => {
    const cache = new LimrunSyncCache();
    let basis = '';
    const pending = cache.run('/unneeded.apk', 'android', async (directory) => {
      basis = directory;
      await fs.writeFile(path.join(directory, 'partial'), 'partial');
      throw cause;
    });
    if (cause instanceof AppError) await expect(pending).rejects.toBe(cause);
    else
      await expect(pending).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { reason: 'limrun_app_sync_failed', platform: 'android' },
        cause,
      });
    await expect(fs.stat(basis)).rejects.toMatchObject({ code: 'ENOENT' });
    await cache.dispose();
  },
);

test('a canceled queued install never reaches the SDK after the previous install settles', async () => {
  const root = await mkdtempForTest('limrun-sync-test-');
  const apk = path.join(root, 'Example.apk');
  await fs.writeFile(apk, 'apk');
  const cache = new LimrunSyncCache();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = cache.run(apk, 'android', async () => await hold);
  const controller = new AbortController();
  let secondRan = false;
  const second = cache.run(
    apk,
    'android',
    async () => {
      secondRan = true;
    },
    controller.signal,
  );
  const reason = new Error('queued install canceled');
  const rejected = expect(second).rejects.toBe(reason);
  controller.abort(reason);
  release();
  await first;
  await rejected;
  expect(secondRan).toBe(false);
  await cache.dispose();
});
