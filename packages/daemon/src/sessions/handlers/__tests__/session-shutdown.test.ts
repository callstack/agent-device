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

// #4908: naming the session that owns a busy device in the refusal is a leak when the caller is
// another client on the same proxy token. The tenant label is not proof of ownership; the lease id
// the caller sends is.
const LEASED_ADDRESS = 'tenant-a:remote-agent';
const SESSION_LEASE_ID = 'a'.repeat(32);

async function shutdownOnLeasedSessionAddress(leaseId: string | undefined) {
  const sessionStore = makeSessionStore();
  const leasedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  sessionStore.publish(LEASED_ADDRESS, {
    name: LEASED_ADDRESS,
    sessionScope: { kind: 'tenant', id: 'tenant-a' },
    device: leasedDevice,
    createdAt: Date.now(),
    actions: [],
    lease: { tenantId: 'tenant-a', runId: 'run-1', leaseId: SESSION_LEASE_ID },
  });
  mockResolveTargetDevice.mockResolvedValue(leasedDevice);
  return await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: LEASED_ADDRESS,
      command: 'shutdown',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
      meta: { tenantId: 'tenant-a', sessionIsolation: 'tenant', ...(leaseId ? { leaseId } : {}) },
    },
    sessionName: LEASED_ADDRESS,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
}

test('shutdown on a leased session address with its lease id names the session in DEVICE_IN_USE', async () => {
  const response = await shutdownOnLeasedSessionAddress(SESSION_LEASE_ID);

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'DEVICE_IN_USE',
      details: {
        session: LEASED_ADDRESS,
        hint: `Run agent-device close --shutdown --session ${LEASED_ADDRESS}`,
      },
    },
  });
});

// Refused before the device check, so the refusal never confirms that the session holds this device.
test('shutdown on a leased session address without its lease id is refused without naming it', async () => {
  const refusal = await shutdownOnLeasedSessionAddress(undefined).catch((error: unknown) => error);

  expect(refusal).toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'LEASE_SESSION_MISMATCH', field: 'leaseId' },
  });
  expect(JSON.stringify(refusal)).not.toContain('remote-agent');
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
      internal: { webSession: { name: 'default' } },
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
    { androidAvdSelection: 'include-stopped', env: process.env, webSession: { name: 'default' } },
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
