import { test, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  mockResolveTargetDevice,
  mockEnsureDeviceReady,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from './session-test-harness.ts';
import type { SessionState } from '../../types.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockEnsureReadyHeadlessRuntime,
  mockEnsureReadyRuntime,
  mockInspectDeviceRuntimeFacts,
  mockShutdownTargetRuntime,
} from './session-command-harness.ts';

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
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledWith(selectedDevice);
  expect(mockBindDeviceRuntime).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).toHaveBeenCalledWith(selectedDevice, {
    required: ['bootTarget'],
    preferred: [],
  });
  expect(mockEnsureReadyRuntime).toHaveBeenCalledOnce();
  expect(mockEnsureReadyHeadlessRuntime).not.toHaveBeenCalled();
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
  if (response && response.ok) {
    expect(response.data?.platform).toBe('ios');
    expect(response.data?.id).toBe('sim-2');
  }
});

test('boot --headless admits a stopped Android emulator through facts and binds once', async () => {
  const sessionStore = makeSessionStore();
  const placeholder: SessionState['device'] = {
    platform: 'android',
    id: 'Pixel_9_Pro_XL',
    name: 'Pixel_9_Pro_XL',
    kind: 'emulator',
    target: 'mobile',
    booted: false,
  };
  mockResolveTargetDevice.mockResolvedValue(placeholder);
  mockEnsureReadyHeadlessRuntime.mockResolvedValue({
    ...placeholder,
    id: 'emulator-5554',
    booted: true,
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
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledWith(placeholder);
  expect(mockBindDeviceRuntime).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).toHaveBeenCalledWith(placeholder, {
    required: ['bootTargetHeadless'],
    preferred: [],
  });
  expect(mockEnsureReadyHeadlessRuntime).toHaveBeenCalledOnce();
  expect(mockEnsureReadyRuntime).not.toHaveBeenCalled();
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.device).toBe('Pixel_9_Pro_XL');
  }
});

test('boot rejects the macOS host boot cell after one facts inspection and before binding', async () => {
  const sessionStore = makeSessionStore();
  const device: SessionState['device'] = {
    platform: 'apple',
    appleOs: 'macos',
    id: 'host-macos-local',
    name: 'Mac',
    kind: 'device',
    target: 'desktop',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(device);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'macos' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(false);
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledWith(device);
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
});

test('boot admits a stopped Android emulator through normal readiness', async () => {
  const sessionStore = makeSessionStore();
  const placeholder: SessionState['device'] = {
    platform: 'android',
    id: 'Pixel_9_Pro_XL',
    name: 'Pixel_9_Pro_XL',
    kind: 'emulator',
    target: 'mobile',
    booted: false,
  };
  mockResolveTargetDevice.mockResolvedValue(placeholder);
  mockEnsureReadyRuntime.mockResolvedValue({
    ...placeholder,
    id: 'emulator-5554',
    booted: true,
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
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledWith(placeholder);
  expect(mockBindDeviceRuntime).toHaveBeenCalledOnce();
  expect(mockEnsureReadyRuntime).toHaveBeenCalledOnce();
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.device).toBe('Pixel_9_Pro_XL');
  }
});

test('boot forwards Android serial admission policy to readiness', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'Pixel_9_Pro_XL',
    name: 'Pixel_9_Pro_XL',
    kind: 'emulator',
    target: 'mobile',
    booted: false,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: {
        platform: 'android',
        serial: 'emulator-5554',
        androidDeviceAllowlist: 'emulator-5554',
      },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockEnsureReadyRuntime).toHaveBeenCalledWith({
    serial: 'emulator-5554',
    androidSerialAllowlist: ['emulator-5554'],
  });
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.device).toBe('Pixel_9_Pro_XL');
  }
});

test('boot --headless requires avd selector when device cannot be resolved', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockRejectedValue(new AppError('DEVICE_NOT_FOUND', 'No device found'));
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
  expect(mockInspectDeviceRuntimeFacts).not.toHaveBeenCalled();
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/boot --headless requires --device <avd-name>/);
  }
});

test('boot --headless rejects non-Android selectors', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    appleOs: 'ios',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
    booted: false,
  });
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
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/headless is supported only for Android emulators/i);
  }
});

test('boot keeps --target validation before facts inspection', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'Pixel_9_Pro_XL',
    name: 'Pixel_9_Pro_XL',
    kind: 'emulator',
    target: 'mobile',
    booted: false,
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
  expect(mockInspectDeviceRuntimeFacts).not.toHaveBeenCalled();
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
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
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).toHaveBeenCalledOnce();
  expect(mockShutdownTargetRuntime).toHaveBeenCalledOnce();
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
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
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
    booted: false,
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
  expect(mockResolveTargetDevice).toHaveBeenCalledWith(
    { platform: 'android', device: 'Pixel_9_Pro_XL' },
    { androidAvdSelection: 'include-stopped' },
  );
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).toHaveBeenCalledOnce();
  expect(mockShutdownTargetRuntime).toHaveBeenCalledOnce();
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
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
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
  mockShutdownTargetRuntime.mockResolvedValue({
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
