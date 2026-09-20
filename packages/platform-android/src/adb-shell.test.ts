import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import {
  createDeviceAdbExecutor,
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  resolveScopedAndroidAdbBackgroundTransport,
  runAdbExecOut,
  runAdbShell,
  withAndroidAdbProvider,
} from './adb-provider-scope.ts';
import { runAndroidAdb, runAndroidExecOut, runAndroidShell } from './adb.ts';
import type { AndroidAdbExecutorResult, AndroidAdbInvocation } from './adb-transport.ts';

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

/** Every raw device-shell argv shape an in-repo caller could hand an executor. */
const RAW_DEVICE_SHELL_ARGV: (readonly string[])[] = [
  ['shell', 'id'],
  ['exec-out', 'screencap', '-p'],
  ['shell', 'input', 'text', 'hello; reboot'],
];

test('every executor and spawner the cluster hands out refuses a raw device-shell argv', async () => {
  bindAndroidAdbHostStub({ execAdb: async () => ok() });
  for (const raw of RAW_DEVICE_SHELL_ARGV) {
    await expect(runAndroidAdb(DEVICE, raw)).rejects.toEqual(UNGUARDED);
    await expect(resolveAndroidAdbExecutor(DEVICE)(raw)).rejects.toEqual(UNGUARDED);
    await expect(createDeviceAdbExecutor(DEVICE)(raw)).rejects.toEqual(UNGUARDED);
    await expect(resolveAndroidAdbProvider(DEVICE).exec(raw)).rejects.toEqual(UNGUARDED);
    expect(() => resolveAndroidAdbProvider(DEVICE).spawn?.(raw)).toThrow(UNGUARDED);
  }
});

test('a provider background transport refuses a raw device-shell spawn', async () => {
  const spawned: (readonly string[])[] = [];
  await withAndroidAdbProvider(
    { exec: async () => ok(), spawn: (args) => spawned.push(args) as never },
    { serial: DEVICE.id },
    async () => {
      const transport = resolveScopedAndroidAdbBackgroundTransport(DEVICE);
      expect(transport.mode).toBe('transport-composed');
      if (transport.mode !== 'transport-composed' || !transport.spawn) {
        throw new Error('expected the scoped spawn transport');
      }
      expect(() => transport.spawn!(['shell', 'logcat'])).toThrow(UNGUARDED);
      transport.spawn!(['logcat']);
    },
  );
  expect(spawned).toEqual([['logcat']]);
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

test('the funnels mint the command every route carries by reference and quote every word', async () => {
  const commands: (readonly string[])[] = [];
  const invocations: AndroidAdbInvocation[] = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation) => {
      commands.push(invocation.command);
      invocations.push(invocation);
      return ok();
    },
  });

  await runAndroidShell(DEVICE, ['am', 'force-stop', 'com.example.app']);
  await runAndroidExecOut(DEVICE, ['screencap', '-p']);
  const adb = resolveAndroidAdbExecutor(DEVICE);
  await runAdbShell(adb, ['input', 'tap', 10, 20]);
  await runAdbExecOut(adb, ['cat', '/sdcard/a b.png']);
  const minted = deviceShellArgv('adb', 'shell', ['getprop', 'sys.boot_completed']);
  await adb(minted);

  expect(commands).toEqual([
    ['shell', 'am', 'force-stop', 'com.example.app'],
    ['exec-out', 'screencap', '-p'],
    ['shell', 'input', 'tap', '10', '20'],
    ['exec-out', 'cat', "'/sdcard/a b.png'"],
    ['shell', 'getprop', 'sys.boot_completed'],
  ]);
  // Addressing travels beside the command, never inside it: the array the funnel minted is the array
  // the host route was addressed with, so the device-shell check can answer by identity.
  expect(invocations.at(-1)?.command).toBe(minted);
});
