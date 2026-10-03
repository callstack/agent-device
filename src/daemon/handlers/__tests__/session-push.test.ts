import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type {
  InspectDeviceRuntimeFacts,
  BindDeviceRuntime,
} from '../../request-runtime-binding.ts';

import type { DaemonRequest, DaemonResponse } from '../../daemon-request.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockEnsureReadyRuntime,
  mockInspectDeviceRuntimeFacts,
  mockPushNotificationRuntime,
} from './session-command-harness.ts';

const invoke = async (_req: DaemonRequest): Promise<DaemonResponse> => {
  return {
    ok: false,
    error: { code: 'INVALID_ARGS', message: 'invoke should not be called in push tests' },
  };
};

test('push requires active session or explicit device selector', async () => {
  const sessionStore = makeSessionStore('agent-device-session-push-');
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'push',
      positionals: ['com.example.app', '{"aps":{"alert":"hi"}}'],
      flags: {},
    },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore,
    invoke,
  });
  expect(response).toBeTruthy();
  if (!response) return;
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/active session or an explicit device selector/i);
});

test('push validates payload before runtime facts admission', async () => {
  const sessionStore = makeSessionStore('agent-device-session-push-invalid-');
  sessionStore.set('default', {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
  });

  await expect(
    handleSessionCommands({
      req: {
        token: 't',
        session: 'default',
        command: 'push',
        positionals: ['com.example.app', '{not json'],
        flags: {},
      },
      sessionName: 'default',
      logPath: '/tmp/daemon.log',
      sessionStore,
      invoke,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(mockInspectDeviceRuntimeFacts).not.toHaveBeenCalled();
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
});

test('push runs readiness and notification through one admitted runtime binding', async () => {
  const sessionStore = makeSessionStore('agent-device-session-push-runtime-');
  sessionStore.set('default', {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
  });
  mockPushNotificationRuntime.mockImplementation(async (input) => {
    expect(input).toEqual({
      appId: 'com.example.app',
      payload: { action: 'com.example.app.TEST_PUSH', extras: { count: 2 } },
    });
    return { action: 'com.example.app.TEST_PUSH', extrasCount: 1 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'push',
      positionals: [
        'com.example.app',
        '{"action":"com.example.app.TEST_PUSH","extras":{"count":2}}',
      ],
      flags: {},
    },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore,
    invoke,
  });

  expect(response).toEqual({
    ok: true,
    data: {
      platform: 'android',
      package: 'com.example.app',
      action: 'com.example.app.TEST_PUSH',
      extrasCount: 1,
      message: 'Pushed notification to com.example.app',
    },
  });
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime.mock.calls[0]?.[1]).toMatchObject({
    required: ['ensureReady', 'sendPushNotification'],
  });
  expect(mockEnsureReadyRuntime).toHaveBeenCalledOnce();
  expect(mockPushNotificationRuntime).toHaveBeenCalledOnce();
});

test('push treats an existing brace-prefixed payload as a file before inline JSON parsing', async () => {
  const sessionStore = makeSessionStore('agent-device-session-push-payload-file-');
  sessionStore.set('default', {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
  });
  const cwd = mkdtempForTestSync('agent-device-session-push-payload-file-');
  const payloadPath = path.join(cwd, '{payload}.json');
  fs.writeFileSync(
    payloadPath,
    JSON.stringify({ action: 'com.example.app.PUSH', extras: { title: 'Hello' } }),
  );
  mockPushNotificationRuntime.mockImplementation(async (input) => {
    expect(input).toEqual({
      appId: 'com.example.app',
      payload: { action: 'com.example.app.PUSH', extras: { title: 'Hello' } },
    });
    return { action: 'com.example.app.PUSH', extrasCount: 1 };
  });

  try {
    const response = await handleSessionCommands({
      req: {
        token: 't',
        session: 'default',
        command: 'push',
        positionals: ['com.example.app', '{payload}.json'],
        flags: {},
        meta: { cwd },
      },
      sessionName: 'default',
      logPath: '/tmp/daemon.log',
      sessionStore,
      invoke,
    });

    expect(response).toMatchObject({ ok: true });
    expect(mockPushNotificationRuntime).toHaveBeenCalledOnce();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('push stops at unavailable facts without binding', async () => {
  const sessionStore = makeSessionStore('agent-device-session-push-unsupported-');
  sessionStore.set('default', {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'physical-1',
      name: 'iPhone',
      kind: 'device',
      booted: true,
    },
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'push',
      positionals: ['com.example.app', '{}'],
      flags: {},
    },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore,
    invoke,
  });

  expect(response).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } });
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(mockEnsureReadyRuntime).not.toHaveBeenCalled();
  expect(mockPushNotificationRuntime).not.toHaveBeenCalled();
});

test('push fails closed before binding when a provider owner lacks readiness', async () => {
  const sessionStore = makeSessionStore('agent-device-session-push-provider-readiness-');
  sessionStore.set('default', {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'android',
      id: 'provider:android:lease-a',
      name: 'Provider Android',
      kind: 'device',
      booted: true,
    },
  });
  const inspectFacts = vi.fn(async (device) => {
    const facts = await mockInspectDeviceRuntimeFacts(device);
    return {
      ...facts,
      device: { ...facts.device, providerMode: 'provider-runtime' as const },
      operations: {
        ...facts.operations,
        ensureReady: { available: false, reason: 'owner-capability-missing' as const },
      },
    };
  }) satisfies InspectDeviceRuntimeFacts;
  const localExecution = vi.fn();
  const bindCalls = vi.fn();
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    bindCalls(device, use);
    localExecution();
    throw new Error('push must not bind after unavailable readiness facts');
  };

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'push',
      positionals: ['com.example.app', '{}'],
      flags: {},
    },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore,
    invoke,
    inspectFacts,
    bindDevice,
  });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'UNSUPPORTED_OPERATION', details: { reason: 'owner-capability-missing' } },
  });
  expect(inspectFacts).toHaveBeenCalledOnce();
  expect(bindCalls).not.toHaveBeenCalled();
  expect(localExecution).not.toHaveBeenCalled();
  expect(mockEnsureReadyRuntime).not.toHaveBeenCalled();
  expect(mockPushNotificationRuntime).not.toHaveBeenCalled();
});
