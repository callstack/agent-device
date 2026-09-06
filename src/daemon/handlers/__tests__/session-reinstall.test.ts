import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { trackUploadedArtifact } from '../../artifact-tracking.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../../daemon-request.ts';
import type { SessionState } from '../../session-state.ts';

vi.mock('../../../core/dispatch-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch-resolve.ts')>();
  return { ...actual, resolveTargetDevice: vi.fn() };
});

import { resolveTargetDevice } from '../../../core/dispatch-resolve.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockDeployAppRuntime,
  mockInspectDeviceRuntimeFacts,
} from './session-command-harness.ts';

function makeStore(): SessionStore {
  return new SessionStore(
    path.join(mkdtempForTestSync('agent-device-session-app-deploy-'), 'sessions'),
  );
}

function makeSession(name: string, device: SessionState['device']): SessionState {
  return { name, device, createdAt: Date.now(), actions: [] };
}

const invoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({
  ok: false,
  error: { code: 'INVALID_ARGS', message: 'invoke should not be called in app deploy tests' },
});

beforeEach(() => {
  mockDeployAppRuntime.mockReset();
  mockDeployAppRuntime.mockResolvedValue({});
  vi.mocked(resolveTargetDevice).mockReset();
});

test('reinstall requires active session or explicit device selector', async () => {
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'reinstall',
      positionals: ['com.example.app', '/tmp/app.apk'],
      flags: {},
    },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: makeStore(),
    invoke,
  });
  expect(response).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS' },
  });
  if (response?.ok !== false) return;
  expect(response.error.message).toMatch(/active session or an explicit device selector/i);
});

test('reinstall validates required args before runtime admission', async () => {
  const store = makeStore();
  store.set(
    'default',
    makeSession('default', {
      platform: 'apple',
      appleOs: 'ios',
      id: 'sim-1',
      name: 'iPhone',
      kind: 'simulator',
      booted: true,
    }),
  );
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'reinstall',
      positionals: ['com.example.app'],
      flags: {},
    },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: store,
    invoke,
  });
  expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  expect(mockInspectDeviceRuntimeFacts).not.toHaveBeenCalled();
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
});

test('install binds the deployment use exactly once after one facts admission', async () => {
  const store = makeStore();
  const session = makeSession('default', {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  store.set(session.name, session);
  const root = mkdtempForTestSync('agent-device-install-runtime-');
  const appPath = path.join(root, 'Sample.apk');
  fs.writeFileSync(appPath, 'placeholder');
  mockDeployAppRuntime.mockImplementation(async (input) => {
    expect(input).toEqual({ app: '', appPath, replaceExisting: false });
    return { packageName: 'com.example.detected', appName: 'Detected App' };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: session.name,
      command: 'install',
      positionals: [appPath],
      flags: {},
    },
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    sessionStore: store,
    invoke,
  });

  expect(response).toMatchObject({
    ok: true,
    data: {
      platform: 'android',
      app: 'com.example.detected',
      appId: 'com.example.detected',
      package: 'com.example.detected',
      appName: 'Detected App',
    },
  });
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime.mock.calls[0]?.[1]).toMatchObject({
    required: ['deployApp'],
  });
});

test('install fails closed before binding when its provider owner lacks deployment', async () => {
  const store = makeStore();
  const session = makeSession('default', {
    platform: 'android',
    id: 'provider:android:lease-a',
    name: 'Provider Android',
    kind: 'device',
    booted: true,
  });
  store.set(session.name, session);
  const root = mkdtempForTestSync('agent-device-install-provider-unavailable-');
  const appPath = path.join(root, 'Sample.apk');
  fs.writeFileSync(appPath, 'placeholder');
  const inspectFacts = vi.fn(async (device) => {
    const facts = await mockInspectDeviceRuntimeFacts(device);
    return {
      ...facts,
      device: { ...facts.device, providerMode: 'provider-runtime' as const },
      operations: {
        ...facts.operations,
        deployApp: { available: false, reason: 'owner-capability-missing' as const },
      },
    };
  }) satisfies InspectDeviceRuntimeFacts;
  const localExecution = vi.fn();
  const bindCalls = vi.fn();
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    bindCalls(device, use);
    localExecution();
    throw new Error('install must not bind after unavailable provider facts');
  };

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: session.name,
      command: 'install',
      positionals: [appPath],
      flags: {},
    },
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    sessionStore: store,
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
  expect(mockDeployAppRuntime).not.toHaveBeenCalled();
});

test('reinstall cleans an uploaded artifact after the request-scoped operation', async () => {
  const store = makeStore();
  const session = makeSession('default', {
    platform: 'apple',
    appleOs: 'ios',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
    booted: true,
  });
  store.set(session.name, session);
  const root = mkdtempForTestSync('agent-device-uploaded-artifact-');
  const appPath = path.join(root, 'Sample.app');
  fs.writeFileSync(appPath, 'placeholder');
  const uploadedArtifactId = trackUploadedArtifact({ artifactPath: appPath, tempDir: root });
  mockDeployAppRuntime.mockResolvedValue({ bundleId: 'com.example.app' });
  vi.mocked(resolveTargetDevice).mockResolvedValue(session.device);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: session.name,
      command: 'reinstall',
      positionals: ['com.example.app', '/Users/dev/Downloads/Sample.app'],
      flags: {},
      meta: { uploadedArtifactId },
    },
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    sessionStore: store,
    invoke,
  });

  expect(response?.ok).toBe(true);
  expect(fs.existsSync(root)).toBe(false);
});

test('HarmonyOS reinstall updates the active session identity from the runtime result', async () => {
  const store = makeStore();
  const session = makeSession('default', {
    platform: 'harmonyos',
    id: '127.0.0.1:5555',
    name: 'emulator',
    kind: 'emulator',
    booted: true,
  });
  store.set(session.name, session);
  const root = mkdtempForTestSync('agent-device-harmony-reinstall-');
  const appPath = path.join(root, 'Sample.hap');
  fs.writeFileSync(appPath, 'placeholder');
  mockDeployAppRuntime.mockResolvedValue({ packageName: 'com.example.application' });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: session.name,
      command: 'reinstall',
      positionals: ['com.example.application', appPath],
      flags: {},
    },
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    sessionStore: store,
    invoke,
  });

  expect(response?.ok).toBe(true);
  expect(store.get(session.name)).toMatchObject({
    appBundleId: 'com.example.application',
    appName: 'com.example.application',
  });
});
