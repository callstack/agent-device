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
  setMacOsAppearance,
} from './apps.ts';
import { macOsToolboxFixture } from './toolbox.fixtures.ts';
import type { MacOsToolbox } from './toolbox.ts';

const withToolbox = async <T>(box: MacOsToolbox, run: (box: MacOsToolbox) => Promise<T>) =>
  await run(box);
import type { MacOsHostProvider } from '@agent-device/contracts/macos-platform-leaf';
import { createLocalMacOsHostProvider } from './host-provider.ts';

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
const box = macOsToolboxFixture();

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

  await closeMacOsApp(box, MACOS_DEVICE, 'com.apple.systempreferences', process.env);

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
    closeMacOsApp(box, MACOS_DEVICE, 'com.apple.systempreferences', process.env),
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
    closeMacOsApp(box, MACOS_DEVICE, 'com.apple.systempreferences', process.env),
  ).rejects.toMatchObject({
    details: { reason: 'MACOS_APP_TERMINATION_TIMEOUT', attempts: 20 },
  });
  expect(mockQuitMacOsApp).toHaveBeenCalledTimes(20);
});

test('an app device opens its own app in the background and the whole Mac opens in front', async () => {
  const opened = async (device: DeviceInfo) => {
    const calls: string[][] = [];
    const provider = macOsToolboxFixture({
      runCommand: async (cmd, args) => {
        if (cmd === 'open') calls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await withToolbox(provider, async (box) => {
      await openMacOsApp(box, device, 'com.example.demo');
      await openMacOsApp(box, device, 'com.example.demo', { url: 'demo://open' });
      await openMacOsApp(box, device, 'demo://open');
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
  await withToolbox(macOsToolboxFixture({ runCommand }), async (box) => {
    for (const attempt of [
      openMacOsApp(box, device, 'com.example.other'),
      closeMacOsApp(box, device, 'com.example.other', {}),
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
  await withToolbox(localHostWith({ listApps }), async (box) => {
    expect(await resolveMacOsApp(box, 'com.apple.TextEdit')).toBe('com.apple.TextEdit');
    expect(await resolveMacOsApp(box, 'COM.APPLE.TEXTEDIT')).toBe('com.apple.TextEdit');
    expect(await resolveMacOsApp(box, 'Foo.Bar')).toBe('com.example.foo');
    expect(await resolveMacOsApp(box, 'com.example.lowercase')).toBe('com.example.lowercase');
  });
});

test('an app device resolves any name of its own app and refuses another app', async () => {
  const listApps = vi.fn(async () => [
    { bundleId: 'com.apple.TextEdit', name: 'TextEdit' },
    { bundleId: 'com.apple.calculator', name: 'Calculator' },
  ]);
  const device = hostAppDevice(MACOS_DEVICE, 'com.apple.TextEdit');
  await withToolbox(localHostWith({ listApps }), async (box) => {
    // Opened by bundle id, closed by name: one app.
    await expect(resolveMacOsAppDeviceOpenTarget(box, device, 'TextEdit')).resolves.toMatchObject({
      appBundleId: 'com.apple.TextEdit',
    });
    await expect(resolveMacOsAppDeviceOpenTarget(box, device, 'Calculator')).rejects.toMatchObject({
      details: { reason: 'app-device-scope' },
    });
  });
});

/** The local host routes with some of them replaced, as a scoped request supplies them. */
function localHostWith(routes: Partial<MacOsHostProvider>) {
  const runCommand = async () => ({ exitCode: 0, stdout: '', stderr: '' });
  const local = createLocalMacOsHostProvider(macOsToolboxFixture({ runCommand }));
  return macOsToolboxFixture({ runCommand, macosHost: { ...local, ...routes } });
}

function macOsHost(apps: Array<{ name: string; bundleId: string }>) {
  const openBundle = vi.fn<MacOsHostProvider['openBundle']>(async () => undefined);
  const listApps = vi.fn(async () => apps);
  const macosHost = { openBundle, listApps } as unknown as MacOsHostProvider;
  return {
    openBundle,
    listApps,
    run: <T>(fn: (box: MacOsToolbox) => Promise<T>) =>
      withToolbox(macOsToolboxFixture({ macosHost }), fn),
  };
}

test('openMacOsApp opens a mixed-case bundle id without display-name resolution', async () => {
  const host = macOsHost([{ name: 'TextEdit', bundleId: 'com.apple.TextEdit' }]);

  await host.run((box) => openMacOsApp(box, MACOS_DEVICE, 'com.apple.TextEdit'));

  expect(host.openBundle).toHaveBeenCalledWith('com.apple.TextEdit', undefined, {
    background: false,
  });
  expect(host.listApps).not.toHaveBeenCalled();
});

test('openMacOsApp resolves a display name to its canonical mixed-case bundle id', async () => {
  const host = macOsHost([{ name: 'TextEdit', bundleId: 'com.apple.TextEdit' }]);

  await host.run((box) => openMacOsApp(box, MACOS_DEVICE, 'TextEdit'));

  expect(host.openBundle).toHaveBeenCalledWith('com.apple.TextEdit', undefined, {
    background: false,
  });
});

test('openMacOsApp keeps the typed error for an app that is not installed', async () => {
  const host = macOsHost([]);

  await expect(
    host.run((box) => openMacOsApp(box, MACOS_DEVICE, 'No Such App')),
  ).rejects.toMatchObject({
    code: 'APP_NOT_INSTALLED',
  });
  expect(host.openBundle).not.toHaveBeenCalled();
});

test.each([
  ['com.apple.TextEdit', 'com.apple.TextEdit'],
  ['com.x.My_App', 'com.x.My_App'],
  ['Booking.com', 'com.booking.BookingApp'],
])('resolveMacOsApp(box, %j) is %j', async (typed, expected) => {
  const host = macOsHost([{ name: 'Booking.com', bundleId: 'com.booking.BookingApp' }]);

  expect(await host.run((box) => resolveMacOsApp(box, typed))).toBe(expected);
  // Only a lowercase-first dotted id is taken as a bundle id as typed; Booking.com is a name.
  expect(host.listApps).toHaveBeenCalledTimes(typed === 'Booking.com' ? 1 : 0);
});

test('an appearance toggle reads the current osascript appearance and sets the other one', async () => {
  const scripts: string[] = [];
  const box = macOsToolboxFixture({
    runCommand: async (cmd, args) => {
      if (cmd !== 'osascript' || args[0] !== '-e') throw new Error(`unexpected ${cmd}`);
      scripts.push(args[1] ?? '');
      return { exitCode: 0, stdout: scripts.length === 1 ? 'true\n' : '', stderr: '' };
    },
  });

  await setMacOsAppearance(box, 'toggle');

  expect(scripts.map((script) => script.split('preferences to ')[1])).toEqual([
    'get dark mode',
    'set dark mode to false',
  ]);
});
