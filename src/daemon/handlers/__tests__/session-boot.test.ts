import { daemonPlatformServicesFixture } from '../../__tests__/platform-services-fixture.ts';
import { test, expect } from 'vitest';
import * as path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  mockResolveTargetDevice,
  mockEnsureDeviceReady,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from './session-test-harness.ts';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { handleBootCommand } from '../session-boot.ts';
import type { SessionState } from '../../session-state.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockEnsureReadyHeadlessRuntime,
  mockEnsureReadyRuntime,
  mockInspectDeviceRuntimeFacts,
} from './session-command-harness.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { testCreateCommandSurface } from '../../__tests__/command-surface-fixture.ts';

test('boot requires session or explicit selector', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
  sessionStore.publish(
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
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'boot',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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

test('boot --timeout forwards a startup deadline to bootTarget (#3004)', async () => {
  const sessionStore = makeSessionStore();
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-timeout',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: false,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const beforeMs = Date.now();
  const response = await handleSessionCommands({
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro', timeoutMs: 300_000 },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  const afterMs = Date.now();

  expect(response?.ok, JSON.stringify(response)).toBe(true);
  expect(mockEnsureReadyRuntime).toHaveBeenCalledOnce();
  const deadlineAtMs = mockEnsureReadyRuntime.mock.calls[0]?.[0]?.deadlineAtMs;
  expect(deadlineAtMs).toBeGreaterThanOrEqual(beforeMs + 300_000);
  expect(deadlineAtMs).toBeLessThanOrEqual(afterMs + 300_000);
});

test('boot without --timeout leaves the startup deadline unset', async () => {
  const sessionStore = makeSessionStore();
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-no-timeout',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: false,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok, JSON.stringify(response)).toBe(true);
  expect(mockEnsureReadyRuntime).toHaveBeenCalledOnce();
  expect(mockEnsureReadyRuntime.mock.calls[0]?.[0]?.deadlineAtMs).toBeUndefined();
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
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android', device: 'Pixel_9_Pro_XL', headless: true },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'macos' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
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
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android', serial: 'emulator-5554', headless: true },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro', headless: true },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'android', target: 'tv', device: 'Pixel_9_Pro_XL' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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

test('boot rejects --headless outside Android directly', async () => {
  const device = {
    platform: 'apple' as const,
    appleOs: 'ios' as const,
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator' as const,
    target: 'mobile' as const,
    booted: false,
  };
  mockResolveTargetDevice.mockResolvedValue(device);
  const response = await handleBootCommand({
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'ios', headless: true },
    },
    sessionName: 'default',
    sessionStore: makeSessionStore(),
    inspectFacts: async () =>
      createUnavailablePlatformRuntimeFacts(device, localRuntimeOwner('apple'), {
        appLog: { available: false, reason: 'owner-capability-missing' },
        network: { available: false, reason: 'owner-capability-missing' },
        screenshot: { available: false, reason: 'owner-capability-missing' },
        viewport: { available: false, reason: 'owner-capability-missing' },
        focus: { available: false, reason: 'owner-capability-missing' },
        gesture: { available: false, reason: 'owner-capability-missing' },
        scroll: { available: false, reason: 'owner-capability-missing' },
        typeText: { available: false, reason: 'owner-capability-missing' },
        touch: { available: false, reason: 'owner-capability-missing' },
        elementText: { available: false, reason: 'owner-capability-missing' },
        back: { available: false, reason: 'owner-capability-missing' },
        orientation: { available: false, reason: 'owner-capability-missing' },
        tvRemote: { available: false, reason: 'owner-capability-missing' },
        keyboard: { available: false, reason: 'owner-capability-missing' },
        clipboard: { available: false, reason: 'owner-capability-missing' },
        systemButton: { available: false, reason: 'owner-capability-missing' },
        fold: { available: false, reason: 'owner-capability-missing' },
        triggerAppEvent: { available: false, reason: 'owner-capability-missing' },
        settings: { available: false, reason: 'owner-capability-missing' },
        readAlert: { available: false, reason: 'owner-capability-missing' },
        awaitAlert: { available: false, reason: 'owner-capability-missing' },
        acceptAlert: { available: false, reason: 'owner-capability-missing' },
        dismissAlert: { available: false, reason: 'owner-capability-missing' },
        audioProbeCapture: { available: false, reason: 'owner-capability-missing' },
        audioProbeQuery: { available: false, reason: 'owner-capability-missing' },
        readiness: { available: false, reason: 'unsupported-device-kind' },
        lifecycle: applicationLifecycleOperationFacts({
          resolveOpenTarget: { available: false, reason: 'owner-capability-missing' },
          prepareApplicationOpen: { available: false, reason: 'owner-capability-missing' },
          openApplication: { available: false, reason: 'owner-capability-missing' },
          applyRuntimeHints: { available: false, reason: 'owner-capability-missing' },
          clearRuntimeHints: { available: false, reason: 'owner-capability-missing' },
          closeApplication: { available: false, reason: 'owner-capability-missing' },
          finalizeApplicationClose: { available: false, reason: 'owner-capability-missing' },
          prepareAppleRunner: { available: false, reason: 'owner-capability-missing' },
          configureProviderPortReverse: {
            available: false,
            reason: 'owner-capability-missing',
          },
        }),
      }),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/supported only for Android emulators/i);
  }
});
