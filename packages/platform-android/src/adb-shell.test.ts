import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import { runAndroidHostAdb } from './adb-host.ts';
import {
  createDeviceAdbExecutor,
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  runAdbExecOut,
  runAdbShell,
  withAndroidAdbProvider,
} from './adb-provider-scope.ts';
import { runAndroidAdb, runAndroidExecOut, runAndroidShell } from './adb.ts';
import type { AndroidAdbExecutorResult } from './adb-transport.ts';

const DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

const ok = (): AndroidAdbExecutorResult => ({ exitCode: 0, stdout: '', stderr: '' });
const UNGUARDED = expect.objectContaining({
  code: 'INVALID_ARGS',
  details: expect.objectContaining({ reason: 'unguarded-device-shell-argv' }),
});

test('every handed-out executor refuses a raw device-shell argv, literal or variable-built', async () => {
  bindAndroidAdbHostStub({ execSerialAdb: async () => ok() });
  const subcommand = 'shell';
  const variableBuilt = [subcommand, 'input', 'text', 'hello'];
  for (const raw of [['shell', 'id'], ['exec-out', 'screencap', '-p'], variableBuilt]) {
    await expect(runAndroidAdb(DEVICE, raw)).rejects.toEqual(UNGUARDED);
    await expect(resolveAndroidAdbExecutor(DEVICE)(raw)).rejects.toEqual(UNGUARDED);
    await expect(createDeviceAdbExecutor(DEVICE)(raw)).rejects.toEqual(UNGUARDED);
    await expect(resolveAndroidAdbProvider(DEVICE).exec(raw)).rejects.toEqual(UNGUARDED);
    await expect(runAndroidHostAdb(['-s', DEVICE.id, ...raw])).rejects.toEqual(UNGUARDED);
  }
});

test('a scoped provider executor is guarded the same as the local one', async () => {
  const calls: (readonly string[])[] = [];
  await withAndroidAdbProvider(
    async (args) => {
      calls.push(args);
      return ok();
    },
    { serial: DEVICE.id },
    async () => {
      await expect(runAndroidAdb(DEVICE, ['shell', 'id'])).rejects.toEqual(UNGUARDED);
      await runAndroidShell(DEVICE, ['input', 'text', "it's a trap; reboot"]);
      await runAndroidAdb(DEVICE, ['reverse', '--list']);
    },
  );
  expect(calls).toEqual([
    ['shell', 'input', 'text', String.raw`'it'\''s a trap; reboot'`],
    ['reverse', '--list'],
  ]);
});

test('the funnels mint the argv the guard accepts and quote every word', async () => {
  const serialCalls: (readonly string[])[] = [];
  const hostCalls: (readonly string[])[] = [];
  bindAndroidAdbHostStub({
    execSerialAdb: async (_serial, args) => {
      serialCalls.push(args);
      return ok();
    },
    execHostAdb: async (args) => {
      hostCalls.push(args);
      return ok();
    },
  });
  await runAndroidShell(DEVICE, ['am', 'force-stop', 'com.example.app']);
  await runAndroidExecOut(DEVICE, ['screencap', '-p']);
  const adb = resolveAndroidAdbExecutor(DEVICE);
  await runAdbShell(adb, ['input', 'tap', 10, 20]);
  await runAdbExecOut(adb, ['cat', '/sdcard/a b.png']);
  await runAndroidHostAdb(
    deviceShellArgv('shell', ['getprop', 'sys.boot_completed'], ['-s', DEVICE.id]),
  );
  expect(serialCalls).toEqual([
    ['shell', 'am', 'force-stop', 'com.example.app'],
    ['exec-out', 'screencap', '-p'],
    ['shell', 'input', 'tap', '10', '20'],
    ['exec-out', 'cat', "'/sdcard/a b.png'"],
  ]);
  expect(hostCalls).toEqual([['-s', DEVICE.id, 'shell', 'getprop', 'sys.boot_completed']]);
});
