import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import {
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  resolveAndroidTextInjector,
  resolveScopedAndroidAdbBackgroundTransport,
  withAndroidAdbProvider,
} from './adb-provider-scope.ts';
import type { AndroidAdbExecutorResult, AndroidAdbProvider } from './adb-transport.ts';

const DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};
const OTHER: DeviceInfo = { ...DEVICE, id: 'emulator-5556' };

const ok = (): AndroidAdbExecutorResult => ({ exitCode: 0, stdout: '', stderr: '' });

test('resolution answers from the installed scope for the matching serial only', async () => {
  bindAndroidAdbHostStub({
    execSerialAdb: async (serial) => {
      throw new Error(`local adb must not run in this test (serial ${serial})`);
    },
  });
  const provider: AndroidAdbProvider = {
    exec: async () => ok(),
    text: async () => {},
  };

  await withAndroidAdbProvider(provider, { serial: DEVICE.id }, async () => {
    await expect(resolveAndroidAdbExecutor(DEVICE)([])).resolves.toEqual(ok());
    expect(resolveAndroidTextInjector(DEVICE)).toBeDefined();
    expect(resolveScopedAndroidAdbBackgroundTransport(DEVICE)).toEqual({
      mode: 'transport-composed',
    });

    // A different serial never routes into this scope's provider.
    expect(resolveAndroidTextInjector(OTHER)).toBeUndefined();
    expect(resolveScopedAndroidAdbBackgroundTransport(OTHER)).toEqual({ mode: 'local' });
  });
});

test('outside any scope, resolution falls back to host adb for the device serial', async () => {
  const serialCalls: Array<[string, string[]]> = [];
  bindAndroidAdbHostStub({
    execSerialAdb: async (serial, args) => {
      serialCalls.push([serial, args]);
      return ok();
    },
  });

  await resolveAndroidAdbExecutor(DEVICE)(['shell', 'echo', 'ok']);
  const provider = resolveAndroidAdbProvider(DEVICE);
  await provider.exec(['shell', 'echo', 'again']);

  expect(serialCalls).toEqual([
    ['emulator-5554', ['shell', 'echo', 'ok']],
    ['emulator-5554', ['shell', 'echo', 'again']],
  ]);
});

test('the installed override routes only normalized device-scoped adb calls to the provider', async () => {
  bindAndroidAdbHostStub();
  const providerCalls: string[][] = [];
  const provider: AndroidAdbProvider = {
    exec: async (args) => {
      providerCalls.push(args);
      return ok();
    },
  };

  // An override-capturing host observes the scope's routing decisions directly.
  let captured:
    | ((cmd: string, args: string[], options: object) => Promise<unknown> | undefined)
    | undefined;
  bindAndroidAdbHostStub({
    withAdbCommandExecutorOverride: async (override, fn) => {
      captured = override;
      return await fn();
    },
  });
  await withAndroidAdbProvider(provider, { serial: DEVICE.id }, async () => {
    expect(captured?.('adb', ['-s', DEVICE.id, 'shell', 'ls'], {})).toBeDefined();
    expect(captured?.('adb', ['-s', OTHER.id, 'shell', 'ls'], {})).toBeUndefined();
    expect(captured?.('adb', ['devices'], {})).toBeUndefined();
    expect(captured?.('emulator', ['-list-avds'], {})).toBeUndefined();
  });
  expect(providerCalls).toEqual([['shell', 'ls']]);
});
