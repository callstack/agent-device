import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { test, expect } from 'vitest';
import * as path from 'node:path';
import {
  mockResolveTargetDevice,
  mockEnsureDeviceReady,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from '../../../__tests__/support/handlers/session-test-harness.ts';
import type { SessionState } from '../../../core/session-state.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
  mockShutdownTargetRuntime,
} from '../../../__tests__/support/handlers/session-command-harness.ts';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';

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
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
  sessionStore.publish(sessionName, makeSession(sessionName, selectedDevice));
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'android', device: 'Pixel_9_Pro_XL' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', udid: 'device-1' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
