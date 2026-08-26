import assert from 'node:assert/strict';
import { test } from 'vitest';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import { withAndroidHostAdbTransport } from './adb-executor.ts';
import { listAndroidAdbSerialsQuick } from './ime-lifecycle.ts';

test('quick serial listing keeps an unbound adb host port loud', async () => {
  await assert.rejects(
    async () => await listAndroidAdbSerialsQuick(),
    /Android adb host port is not bound/,
  );
});

test('quick serial listing routes its global devices call through the scoped transport', async () => {
  bindAndroidAdbHostStub();
  const seenArgs: string[][] = [];

  const serials = await withAndroidHostAdbTransport(
    async (args) => {
      seenArgs.push([...args]);
      return {
        stdout: 'List of devices attached\nemulator-5554\tdevice\n',
        stderr: '',
        exitCode: 0,
      };
    },
    async () => await listAndroidAdbSerialsQuick(),
  );

  assert.deepEqual(serials, ['emulator-5554']);
  assert.deepEqual(seenArgs, [['devices']]);
});

test('quick serial listing treats a classified transport failure as empty inventory', async () => {
  bindAndroidAdbHostStub();
  const serials = await withAndroidHostAdbTransport(
    async () => ({ stdout: '', stderr: 'error: device offline', exitCode: 1 }),
    async () => await listAndroidAdbSerialsQuick(),
  );

  assert.deepEqual(serials, []);
});
