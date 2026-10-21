import { afterEach, expect, test, vi } from 'vitest';
import { hostAppDevice, type DeviceInfo } from '@agent-device/kernel/device';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));
vi.mock('./helper.ts', () => ({ quitMacOsApp: vi.fn() }));

import { quitMacOsApp } from './helper.ts';
import {
  closeMacOsApp,
  openMacOsApp,
  resolveMacOsApp,
  resolveMacOsAppDeviceOpenTarget,
} from './apps.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../../core/tool-provider.ts';

const MACOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

const mockQuitMacOsApp = vi.mocked(quitMacOsApp);

afterEach(() => {
  mockQuitMacOsApp.mockReset();
});

test('closeMacOsApp waits until an accepted termination has actually completed', async () => {
  mockQuitMacOsApp
    .mockResolvedValueOnce({
      bundleId: 'com.apple.systempreferences',
      running: true,
      terminated: true,
      forceTerminated: false,
    })
    .mockResolvedValueOnce({
      bundleId: 'com.apple.systempreferences',
      running: true,
      terminated: false,
      forceTerminated: false,
    })
    .mockResolvedValueOnce({
      bundleId: 'com.apple.systempreferences',
      running: false,
      terminated: false,
      forceTerminated: false,
    });

  await closeMacOsApp(MACOS_DEVICE, 'com.apple.systempreferences', process.env);

  expect(mockQuitMacOsApp).toHaveBeenCalledTimes(3);
});

test('closeMacOsApp fails immediately when neither termination request is accepted', async () => {
  mockQuitMacOsApp.mockResolvedValue({
    bundleId: 'com.apple.systempreferences',
    running: true,
    terminated: false,
    forceTerminated: false,
  });

  await expect(
    closeMacOsApp(MACOS_DEVICE, 'com.apple.systempreferences', process.env),
  ).rejects.toThrow('Failed to close macOS app com.apple.systempreferences');
  expect(mockQuitMacOsApp).toHaveBeenCalledTimes(1);
});

test('closeMacOsApp bounds termination confirmation', async () => {
  mockQuitMacOsApp.mockResolvedValue({
    bundleId: 'com.apple.systempreferences',
    running: true,
    terminated: true,
    forceTerminated: false,
  });

  await expect(
    closeMacOsApp(MACOS_DEVICE, 'com.apple.systempreferences', process.env),
  ).rejects.toMatchObject({
    details: { reason: 'MACOS_APP_TERMINATION_TIMEOUT', attempts: 20 },
  });
  expect(mockQuitMacOsApp).toHaveBeenCalledTimes(20);
});

test('an app device opens its own app in the background and the whole Mac opens in front', async () => {
  const opened = async (device: DeviceInfo) => {
    const calls: string[][] = [];
    const provider = createLocalAppleToolProvider({
      runCommand: async (cmd, args) => {
        if (cmd === 'open') calls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await withAppleToolProvider(provider, async () => {
      await openMacOsApp(device, 'com.example.demo');
      await openMacOsApp(device, 'com.example.demo', { url: 'demo://open' });
      await openMacOsApp(device, 'demo://open');
    });
    return calls;
  };

  expect(await opened(hostAppDevice(MACOS_DEVICE, 'com.Example.Demo'))).toEqual([
    ['-g', '-b', 'com.example.demo'],
    ['-g', '-b', 'com.example.demo', 'demo://open'],
    ['-g', '-b', 'com.Example.Demo', 'demo://open'],
  ]);
  expect(await opened(MACOS_DEVICE)).toEqual([
    ['-b', 'com.example.demo'],
    ['-b', 'com.example.demo', 'demo://open'],
    ['demo://open'],
  ]);
});

test('an app device refuses to open or close another app before anything runs', async () => {
  const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  const device = hostAppDevice(MACOS_DEVICE, 'com.example.demo');
  await withAppleToolProvider(createLocalAppleToolProvider({ runCommand }), async () => {
    for (const attempt of [
      openMacOsApp(device, 'com.example.other'),
      closeMacOsApp(device, 'com.example.other', {}),
    ]) {
      await expect(attempt).rejects.toMatchObject({
        code: 'INVALID_ARGS',
        details: { reason: 'app-device-scope', bundleId: 'com.example.demo' },
      });
    }
  });
  expect(runCommand).not.toHaveBeenCalled();
  expect(mockQuitMacOsApp).not.toHaveBeenCalled();
});

test('a bundle id in another case resolves to the installed app; a dotted name stays a name', async () => {
  const listApps = vi.fn(async () => [
    { bundleId: 'com.apple.TextEdit', name: 'TextEdit' },
    { bundleId: 'com.example.foo', name: 'Foo.Bar' },
  ]);
  const provider = createLocalAppleToolProvider({
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  await withAppleToolProvider(
    { ...provider, macosHost: { ...provider.macosHost!, listApps } },
    async () => {
      expect(await resolveMacOsApp('com.apple.TextEdit')).toBe('com.apple.TextEdit');
      expect(await resolveMacOsApp('COM.APPLE.TEXTEDIT')).toBe('com.apple.TextEdit');
      expect(await resolveMacOsApp('Foo.Bar')).toBe('com.example.foo');
      expect(await resolveMacOsApp('com.example.lowercase')).toBe('com.example.lowercase');
    },
  );
});

test('an app device resolves any name of its own app and refuses another app', async () => {
  const listApps = vi.fn(async () => [
    { bundleId: 'com.apple.TextEdit', name: 'TextEdit' },
    { bundleId: 'com.apple.calculator', name: 'Calculator' },
  ]);
  const provider = createLocalAppleToolProvider({
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  const device = hostAppDevice(MACOS_DEVICE, 'com.apple.TextEdit');
  await withAppleToolProvider(
    { ...provider, macosHost: { ...provider.macosHost!, listApps } },
    async () => {
      // Opened by bundle id, closed by name: one app.
      await expect(resolveMacOsAppDeviceOpenTarget(device, 'TextEdit')).resolves.toMatchObject({
        appBundleId: 'com.apple.TextEdit',
      });
      await expect(resolveMacOsAppDeviceOpenTarget(device, 'Calculator')).rejects.toMatchObject({
        details: { reason: 'app-device-scope' },
      });
    },
  );
});
