import { test, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppError } from '../../../kernel/errors.ts';
import {
  mockResolveTargetDevice,
  mockEnsureDeviceReady,
  mockPrewarmAppleRunnerCache,
  mockRunCmd,
  mockShutdownSimulator,
  mockEnsureAndroidEmulatorBooted,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from './session-test-harness.ts';
import type { SessionState } from '../../types.ts';
import { handleSessionCommands } from '../session.ts';

test('boot requires session or explicit selector', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
  }
});

test('boot prefers explicit device selector over active session device', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
  );
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'boot',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockEnsureDeviceReady).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'sim-2' }),
    expect.any(Object),
  );
  const onColdBootStart = mockEnsureDeviceReady.mock.calls[0]?.[1]?.onIosSimulatorColdBootStart;
  expect(onColdBootStart).toBeTypeOf('function');
  onColdBootStart?.(selectedDevice);
  expect(mockPrewarmAppleRunnerCache).toHaveBeenCalledWith(
    selectedDevice,
    expect.objectContaining({
      logPath: expect.stringMatching(/daemon\.log$/),
    }),
  );
  if (response && response.ok) {
    expect(response.data?.platform).toBe('ios');
    expect(response.data?.id).toBe('sim-2');
  }
});

test('boot --headless launches Android emulator when no running device matches', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockRejectedValue(new AppError('DEVICE_NOT_FOUND', 'No device found'));
  const launchCalls: Array<{ avdName: string; serial?: string; headless?: boolean }> = [];
  mockEnsureAndroidEmulatorBooted.mockImplementation(async ({ avdName, serial, headless }) => {
    launchCalls.push({ avdName, serial, headless });
    return {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel_9_Pro_XL',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    };
  });
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android', device: 'Pixel_9_Pro_XL', headless: true },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(launchCalls).toEqual([{ avdName: 'Pixel_9_Pro_XL', serial: undefined, headless: true }]);
  expect(mockEnsureDeviceReady).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'emulator-5554' }),
  );
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.device).toBe('Pixel_9_Pro_XL');
  }
});

test('boot launches Android emulator with GUI when no running device matches', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockRejectedValue(new AppError('DEVICE_NOT_FOUND', 'No device found'));
  const launchCalls: Array<{ avdName: string; serial?: string; headless?: boolean }> = [];
  mockEnsureAndroidEmulatorBooted.mockImplementation(async ({ avdName, serial, headless }) => {
    launchCalls.push({ avdName, serial, headless });
    return {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel_9_Pro_XL',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    };
  });
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android', device: 'Pixel_9_Pro_XL' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(launchCalls).toEqual([{ avdName: 'Pixel_9_Pro_XL', serial: undefined, headless: false }]);
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.device).toBe('Pixel_9_Pro_XL');
  }
});

test('boot launches stopped Android emulator selected from inventory', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'Pixel_9_Pro_XL',
    name: 'Pixel_9_Pro_XL',
    kind: 'emulator',
    target: 'mobile',
    booted: false,
  });
  const launchCalls: Array<{ avdName: string; serial?: string; headless?: boolean }> = [];
  mockEnsureAndroidEmulatorBooted.mockImplementation(async ({ avdName, serial, headless }) => {
    launchCalls.push({ avdName, serial, headless });
    return {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel_9_Pro_XL',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(launchCalls).toEqual([{ avdName: 'Pixel_9_Pro_XL', serial: undefined, headless: false }]);
  expect(mockEnsureDeviceReady).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'emulator-5554', booted: true }),
  );
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.device).toBe('Pixel_9_Pro_XL');
  }
});

test('boot --headless requires avd selector when device cannot be resolved', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockRejectedValue(new AppError('DEVICE_NOT_FOUND', 'No device found'));
  mockEnsureAndroidEmulatorBooted.mockRejectedValue(new Error('unexpected'));
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android', serial: 'emulator-5554', headless: true },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockEnsureAndroidEmulatorBooted).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/boot --headless requires --device <avd-name>/);
  }
});

test('boot --headless rejects non-Android selectors', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro', headless: true },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockEnsureAndroidEmulatorBooted).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/headless is supported only for Android emulators/i);
  }
});

test('boot keeps --target validation when emulator is fallback-launched', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockRejectedValue(new AppError('DEVICE_NOT_FOUND', 'No device found'));
  const launchCalls: Array<{ avdName: string; serial?: string; headless?: boolean }> = [];
  mockEnsureAndroidEmulatorBooted.mockImplementation(async ({ avdName, serial, headless }) => {
    launchCalls.push({ avdName, serial, headless });
    return {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel_9_Pro_XL',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    };
  });
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android', target: 'tv', device: 'Pixel_9_Pro_XL' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
  expect(launchCalls).toEqual([{ avdName: 'Pixel_9_Pro_XL', serial: undefined, headless: false }]);
  if (response && !response.ok) {
    expect(response.error.code).toBe('DEVICE_NOT_FOUND');
    expect(response.error.message).toMatch(/matching --target tv/i);
  }
});

test('shutdown turns off selected iOS simulator', async () => {
  const sessionStore = makeSessionStore();
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
  expect(mockShutdownSimulator).toHaveBeenCalledWith(selectedDevice);
  if (response && response.ok) {
    expect(response.data?.platform).toBe('ios');
    expect(response.data?.id).toBe('sim-2');
    expect(response.data?.shutdown).toEqual({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  }
});

test('shutdown rejects active session device and points to close --shutdown', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  sessionStore.set(sessionName, makeSession(sessionName, selectedDevice));
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockShutdownSimulator).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('DEVICE_IN_USE');
    expect(response.error.message).toMatch(/close --shutdown/i);
    expect(response.error.details?.hint).toBe(
      'Run agent-device close --shutdown --session default',
    );
  }
});

test('shutdown turns off selected Android emulator', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel_9_Pro_XL',
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'android', device: 'Pixel_9_Pro_XL' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
  expect(mockRunCmd).toHaveBeenCalledWith(
    'adb',
    ['-s', 'emulator-5554', 'emu', 'kill'],
    expect.objectContaining({ allowFailure: true, timeoutMs: 15_000 }),
  );
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.shutdown).toEqual({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  }
});

test('shutdown rejects unsupported physical devices', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'device-1',
    name: 'iPhone',
    kind: 'device',
    target: 'mobile',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', udid: 'device-1' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockShutdownSimulator).not.toHaveBeenCalled();
  expect(mockRunCmd).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/Apple simulators and Android emulators/i);
  }
});

test('shutdown returns an error response when selected target shutdown fails', async () => {
  const sessionStore = makeSessionStore();
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);
  mockShutdownSimulator.mockResolvedValue({
    success: false,
    exitCode: 149,
    stdout: '',
    stderr: 'simctl shutdown failed',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toBe('simctl shutdown failed');
    expect(response.error.details?.shutdown).toEqual({
      success: false,
      exitCode: 149,
      stdout: '',
      stderr: 'simctl shutdown failed',
    });
  }
});
