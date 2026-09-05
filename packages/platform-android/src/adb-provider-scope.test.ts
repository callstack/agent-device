import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import {
  createLocalAndroidAdbProvider,
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  resolveAndroidTextInjector,
  resolveScopedAndroidAdbBackgroundTransport,
  withAndroidAdbProvider,
} from './adb-provider-scope.ts';
import { runAndroidHostAdb } from './adb-host.ts';
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

test('a managed port scope routes host adb and matching serial calls to its private server', async () => {
  const hostCalls: Array<{ args: string[]; serverPort?: number }> = [];
  bindAndroidAdbHostStub({
    execHostAdb: async (args, options) => {
      hostCalls.push({ args, serverPort: options?.serverPort });
      return ok();
    },
  });

  await withAndroidAdbProvider(
    { exec: async () => ok() },
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      await runAndroidHostAdb(['devices']);
      await runAndroidHostAdb(['-s', DEVICE.id, 'shell', 'getprop']);
      await runAndroidHostAdb(['-s', OTHER.id, 'shell', 'getprop']);
    },
  );
  await runAndroidHostAdb(['devices']);

  expect(hostCalls).toEqual([
    { args: ['devices'], serverPort: 15_037 },
    { args: ['-s', DEVICE.id, 'shell', 'getprop'], serverPort: 15_037 },
    { args: ['-s', OTHER.id, 'shell', 'getprop'] },
    { args: ['devices'] },
  ]);
});

test('a managed port scope classifies absolute adb commands and preserves the default boundary', async () => {
  const providerCalls: string[][] = [];
  const hostCalls: string[][] = [];
  let captured:
    | ((cmd: string, args: string[], options: object) => Promise<unknown> | undefined)
    | undefined;
  bindAndroidAdbHostStub({
    execHostAdb: async (args) => {
      hostCalls.push(args);
      return ok();
    },
    withAdbCommandExecutorOverride: async (override, fn) => {
      captured = override;
      return await fn();
    },
  });

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        providerCalls.push(args);
        return ok();
      },
    },
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      const global = captured?.('/opt/android-sdk/platform-tools/adb', ['devices', '-l'], {});
      const matching = captured?.(
        '/opt/android-sdk/platform-tools/adb',
        ['-s', DEVICE.id, 'shell', 'ls'],
        {},
      );
      expect(captured?.('adb', ['-s', OTHER.id, 'shell', 'ls'], {})).toBeUndefined();
      expect(captured?.('emulator', ['-list-avds'], {})).toBeUndefined();
      expect(global).toBeDefined();
      expect(matching).toBeDefined();
      await global;
      await matching;
    },
  );

  expect(hostCalls).toEqual([['devices', '-l']]);
  expect(providerCalls).toEqual([['shell', 'ls']]);
});

test('a managed port scope keeps shell -s arguments on the private transport', async () => {
  const hostCalls: Array<{ args: string[]; serverPort?: number }> = [];
  let captured:
    | ((cmd: string, args: string[], options: object) => Promise<unknown> | undefined)
    | undefined;
  bindAndroidAdbHostStub({
    execHostAdb: async (args, options) => {
      hostCalls.push({ args, serverPort: options?.serverPort });
      return ok();
    },
    withAdbCommandExecutorOverride: async (override, fn) => {
      captured = override;
      return await fn();
    },
  });

  await withAndroidAdbProvider(
    { exec: async () => ok() },
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      await runAndroidHostAdb(['shell', 'echo', '-s', OTHER.id]);
      const shellCommand = captured?.('adb', ['shell', 'echo', '-s', OTHER.id], {});
      expect(shellCommand).toBeDefined();
      await shellCommand;
    },
  );

  expect(hostCalls).toEqual([
    { args: ['shell', 'echo', '-s', OTHER.id], serverPort: 15_037 },
    { args: ['shell', 'echo', '-s', OTHER.id], serverPort: 15_037 },
  ]);
});

test('a managed port scope restores the default transport after task failure', async () => {
  const ports: Array<number | undefined> = [];
  bindAndroidAdbHostStub({
    execHostAdb: async (_args, options) => {
      ports.push(options?.serverPort);
      return ok();
    },
  });

  await expect(
    withAndroidAdbProvider(
      { exec: async () => ok() },
      { serial: DEVICE.id, serverPort: 15_037 },
      async () => {
        await runAndroidHostAdb(['devices']);
        throw new Error('stop managed request');
      },
    ),
  ).rejects.toThrow('stop managed request');
  await runAndroidHostAdb(['devices']);

  expect(ports).toEqual([15_037, undefined]);
});

test('a managed port scope carries its server through the local background transport', async () => {
  const spawnCalls: Array<{ serial: string; args: string[]; serverPort?: number }> = [];
  bindAndroidAdbHostStub({
    spawnSerialAdb: (serial, args, options) => {
      spawnCalls.push({ serial, args, serverPort: options?.serverPort });
      return undefined as never;
    },
  });
  const deviceProvider = createLocalAndroidAdbProvider(DEVICE, { serverPort: 15_037 });

  await withAndroidAdbProvider(
    deviceProvider,
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      const transport = resolveScopedAndroidAdbBackgroundTransport(DEVICE);
      expect(transport.mode).toBe('transport-composed');
      if (transport.mode === 'transport-composed') {
        transport.spawn?.(['logcat', '-v', 'threadtime']);
      }
    },
  );

  expect(spawnCalls).toEqual([
    { serial: DEVICE.id, args: ['logcat', '-v', 'threadtime'], serverPort: 15_037 },
  ]);
});

test('managed port scopes remain isolated across concurrent requests', async () => {
  const hostCalls: Array<{ serial: string; serverPort?: number }> = [];
  bindAndroidAdbHostStub({
    execHostAdb: async (args, options) => {
      hostCalls.push({
        serial: args[args.indexOf('-s') + 1] ?? 'global',
        serverPort: options?.serverPort,
      });
      await Promise.resolve();
      return ok();
    },
  });

  await Promise.all([
    withAndroidAdbProvider(
      { exec: async () => ok() },
      { serial: DEVICE.id, serverPort: 15_037 },
      async () => await runAndroidHostAdb(['-s', DEVICE.id, 'shell', 'id']),
    ),
    withAndroidAdbProvider(
      { exec: async () => ok() },
      { serial: OTHER.id, serverPort: 15_038 },
      async () => await runAndroidHostAdb(['-s', OTHER.id, 'shell', 'id']),
    ),
  ]);

  expect(hostCalls).toEqual([
    { serial: DEVICE.id, serverPort: 15_037 },
    { serial: OTHER.id, serverPort: 15_038 },
  ]);
});
