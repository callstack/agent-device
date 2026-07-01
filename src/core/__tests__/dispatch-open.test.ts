import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { dispatchCommand } from '../dispatch.ts';
import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { openIosApp, setIosSetting } from '../../platforms/apple/core/apps.ts';
import { openAndroidApp } from '../../platforms/android/app-lifecycle.ts';
import { setAndroidSetting } from '../../platforms/android/settings.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';

vi.mock('../../platforms/apple/core/apps.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/apple/core/apps.ts')>();
  return {
    ...actual,
    openIosApp: vi.fn(async () => {}),
    setIosSetting: vi.fn(async () => ({ bundleId: 'com.example.app', cleared: true })),
  };
});

vi.mock('../../platforms/android/app-lifecycle.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/android/app-lifecycle.ts')>();
  return {
    ...actual,
    openAndroidApp: vi.fn(async () => {}),
  };
});

vi.mock('../../platforms/android/settings.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/android/settings.ts')>();
  return {
    ...actual,
    setAndroidSetting: vi.fn(async () => ({ package: 'com.example.app', cleared: true })),
  };
});

const mockSetIosSetting = vi.mocked(setIosSetting);
const mockOpenIosApp = vi.mocked(openIosApp);
const mockOpenAndroidApp = vi.mocked(openAndroidApp);
const mockSetAndroidSetting = vi.mocked(setAndroidSetting);

beforeEach(() => {
  mockSetIosSetting.mockClear();
  mockOpenIosApp.mockClear();
  mockOpenAndroidApp.mockClear();
  mockSetAndroidSetting.mockClear();
});

test('dispatch open rejects URL as first argument when second URL is provided', async () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 15',
    kind: 'simulator',
    booted: true,
  };

  await assert.rejects(
    () => dispatchCommand(device, 'open', ['myapp://first', 'myapp://second']),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /requires an app target as the first argument/i);
      return true;
    },
  );
});

test('dispatch open rejects launch arguments without an app target', async () => {
  await assert.rejects(
    () => dispatchCommand(IOS_SIMULATOR, 'open', [], undefined, { launchArgs: ['-Flag'] }),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /requires an app target/i);
      return true;
    },
  );
});

test('dispatch open forwards Android launch arguments to openAndroidApp', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  await dispatchCommand(device, 'open', ['com.example.app'], undefined, {
    launchArgs: ['--es', 'KEY', 'value'],
  });

  assert.equal(mockOpenAndroidApp.mock.calls.length, 1);
  assert.equal(mockOpenAndroidApp.mock.calls[0]?.[0], device);
  assert.equal(mockOpenAndroidApp.mock.calls[0]?.[1], 'com.example.app');
  const optionsArg = mockOpenAndroidApp.mock.calls[0]?.[2];
  assert.ok(optionsArg && typeof optionsArg === 'object', 'expected options object');
  assert.deepEqual(optionsArg.launchArgs, ['--es', 'KEY', 'value']);
});

test('dispatch open rejects launch arguments on Linux', async () => {
  const device: DeviceInfo = {
    platform: 'linux',
    id: 'linux-local',
    name: 'Linux',
    kind: 'device',
    booted: true,
  };

  await assert.rejects(
    () =>
      dispatchCommand(device, 'open', ['org.example.App'], undefined, {
        launchArgs: ['--fixture', 'demo'],
      }),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'UNSUPPORTED_OPERATION');
      assert.match((error as AppError).message, /Linux/i);
      return true;
    },
  );
});

test('dispatch open clears Maestro iOS simulator state and launches once', async () => {
  const result = await dispatchCommand(IOS_SIMULATOR, 'open', ['com.example.app'], undefined, {
    clearAppState: true,
    launchArgs: ['-EXDevMenuIsOnboardingFinished', 'true'],
  });

  assert.equal(result?.app, 'com.example.app');
  assert.equal(mockSetIosSetting.mock.calls.length, 1);
  assert.deepEqual(mockSetIosSetting.mock.calls[0]?.slice(0, 4), [
    IOS_SIMULATOR,
    'clear-app-state',
    'clear',
    'com.example.app',
  ]);
  assert.equal(mockOpenIosApp.mock.calls.length, 1);
  assert.equal(mockOpenIosApp.mock.calls[0]?.[0], IOS_SIMULATOR);
  assert.equal(mockOpenIosApp.mock.calls[0]?.[1], 'com.example.app');
  assert.deepEqual(mockOpenIosApp.mock.calls[0]?.[2]?.launchArgs, [
    '-EXDevMenuIsOnboardingFinished',
    'true',
  ]);
});

test('dispatch open clears Android app data before launch', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  const result = await dispatchCommand(device, 'open', ['com.example.app'], undefined, {
    clearAppState: true,
  });

  assert.equal(result?.app, 'com.example.app');
  assert.equal(mockSetAndroidSetting.mock.calls.length, 1);
  assert.deepEqual(mockSetAndroidSetting.mock.calls[0]?.slice(0, 4), [
    device,
    'clear-app-state',
    'clear',
    'com.example.app',
  ]);
  assert.equal(mockOpenAndroidApp.mock.calls.length, 1);
});

test('dispatch settings clear-app-state uses the active session app by default', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  const result = await dispatchCommand(device, 'settings', ['clear-app-state'], undefined, {
    appBundleId: 'com.example.app',
  });

  assert.equal(result?.setting, 'clear-app-state');
  assert.equal(result?.state, 'clear');
  assert.equal(mockSetAndroidSetting.mock.calls.length, 1);
  assert.deepEqual(mockSetAndroidSetting.mock.calls[0]?.slice(0, 4), [
    device,
    'clear-app-state',
    'clear',
    'com.example.app',
  ]);
});
