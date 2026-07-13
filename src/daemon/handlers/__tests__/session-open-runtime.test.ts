import { test, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import { AppError } from '../../../kernel/errors.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});
vi.mock('../../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('../../runtime-hints.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime-hints.ts')>();
  return {
    ...actual,
    applyRuntimeHintsToApp: vi.fn(async () => {}),
    clearRuntimeHintsFromApp: vi.fn(async () => {}),
  };
});
vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return {
    ...actual,
    prewarmIosRunnerSession: vi.fn(),
    stopIosRunnerSession: vi.fn(async () => {}),
  };
});
vi.mock('../../../platforms/apple/core/apps.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platforms/apple/core/apps.ts')>();
  return {
    ...actual,
    resolveIosApp: vi.fn(async () => 'com.example.demo'),
  };
});
vi.mock('../session-device-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-device-utils.ts')>();
  return { ...actual, settleIosSimulator: vi.fn(async () => {}) };
});
vi.mock('../session-open-target.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-open-target.ts')>();
  return { ...actual, resolveAndroidPackageForOpen: vi.fn(async () => undefined) };
});
vi.mock('../../../platforms/android/ime-lifecycle.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/ime-lifecycle.ts')>();
  return { ...actual, activateAndroidTestIme: vi.fn(async () => ({ activated: false })) };
});

import { handleSessionCommands } from '../session.ts';
import { dispatchCommand, resolveTargetDevice } from '../../../core/dispatch.ts';
import { applyRuntimeHintsToApp, clearRuntimeHintsFromApp } from '../../runtime-hints.ts';
import { resolveAndroidPackageForOpen } from '../session-open-target.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const mockApplyRuntimeHints = vi.mocked(applyRuntimeHintsToApp);
const mockClearRuntimeHints = vi.mocked(clearRuntimeHintsFromApp);
const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);

const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({ ok: true, data: {} });

function makeSessionStore(): SessionStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-session-open-runtime-'));
  return new SessionStore(path.join(root, 'sessions'));
}

function makeSession(name: string, device: SessionState['device']): SessionState {
  return {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockImplementation(async () => ({}));
  mockResolveAndroidPackage.mockResolvedValue(undefined);
});

test('open applies stored runtime launchUrl and reports runtime hints', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.setRuntimeHints('runtime-open', {
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
    launchUrl: 'myapp://dev-client',
  });
  const dispatchCalls: Array<{ command: string; positionals: string[] }> = [];
  const runtimeApplyCalls: Array<{ appId?: string; host?: string; port?: number }> = [];
  const callOrder: string[] = [];

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  mockApplyRuntimeHints.mockImplementation(async ({ appId, runtime }) => {
    callOrder.push('runtime');
    runtimeApplyCalls.push({
      appId,
      host: runtime?.metroHost,
      port: runtime?.metroPort,
    });
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    callOrder.push(`dispatch:${command}`);
    dispatchCalls.push({ command, positionals });
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'runtime-open',
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
    },
    sessionName: 'runtime-open',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(callOrder).toEqual(['runtime', 'dispatch:open', 'dispatch:open']);
  expect(runtimeApplyCalls).toEqual([{ appId: 'com.example.demo', host: '10.0.0.10', port: 8081 }]);
  expect(dispatchCalls).toEqual([
    { command: 'open', positionals: ['Demo'] },
    { command: 'open', positionals: ['myapp://dev-client'] },
  ]);
  if (response && response.ok) {
    expect(response.data?.platform).toBe('android');
    expect(response.data?.target).toBe('mobile');
    expect(response.data?.device).toBe('Pixel');
    expect(response.data?.id).toBe('emulator-5554');
    expect(response.data?.serial).toBe('emulator-5554');
    expect(response.data?.runtime).toEqual({
      platform: 'android',
      metroHost: '10.0.0.10',
      metroPort: 8081,
      launchUrl: 'myapp://dev-client',
    });
  }
});

test('open applies launch-only flags only to the direct app launch before runtime launchUrl', async () => {
  const sessionStore = makeSessionStore();
  const launchConsolePath = path.join(os.tmpdir(), 'launch-console.log');
  const dispatchCalls: Array<{
    command: string;
    positionals: string[];
    launchConsole?: string;
    launchArgs?: string[];
  }> = [];

  sessionStore.setRuntimeHints('launch-console-runtime', {
    platform: 'ios',
    launchUrl: 'myapp://dev-client',
  });
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 15',
    kind: 'simulator',
    booted: true,
  });
  mockDispatch.mockImplementation(async (_device, command, positionals, _outPath, context) => {
    dispatchCalls.push({
      command,
      positionals,
      launchConsole: context?.launchConsole,
      launchArgs: context?.launchArgs,
    });
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'launch-console-runtime',
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'ios', launchConsole: launchConsolePath, launchArgs: ['-Flag', 'YES'] },
    },
    sessionName: 'launch-console-runtime',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(dispatchCalls).toEqual([
    {
      command: 'open',
      positionals: ['Demo'],
      launchConsole: launchConsolePath,
      launchArgs: ['-Flag', 'YES'],
    },
    {
      command: 'open',
      positionals: ['myapp://dev-client'],
      launchConsole: undefined,
      launchArgs: undefined,
    },
  ]);
});

test('open runtime payload replaces stored session runtime atomically', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-open-inline';
  sessionStore.setRuntimeHints(sessionName, {
    platform: 'android',
    metroHost: '127.0.0.1',
    metroPort: 9000,
    launchUrl: 'myapp://stale',
  });

  const dispatchCalls: Array<{ command: string; positionals: string[] }> = [];
  const runtimeApplyCalls: Array<{
    appId?: string;
    host?: string;
    port?: number;
    launchUrl?: string;
  }> = [];

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  mockApplyRuntimeHints.mockImplementation(async ({ appId, runtime }) => {
    runtimeApplyCalls.push({
      appId,
      host: runtime?.metroHost,
      port: runtime?.metroPort,
      launchUrl: runtime?.launchUrl,
    });
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    dispatchCalls.push({ command, positionals });
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: {
        metroHost: '10.0.0.10',
        metroPort: 8081,
      },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(runtimeApplyCalls).toEqual([
    { appId: 'com.example.demo', host: '10.0.0.10', port: 8081, launchUrl: undefined },
  ]);
  expect(dispatchCalls).toEqual([{ command: 'open', positionals: ['Demo'] }]);
  expect(sessionStore.getRuntimeHints(sessionName)).toEqual({
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
    bundleUrl: undefined,
    launchUrl: undefined,
  });
  expect(sessionStore.get(sessionName)?.actions.map((action) => action.command)).toEqual(['open']);
  expect(sessionStore.get(sessionName)?.actions[0]?.runtime).toEqual({
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
    bundleUrl: undefined,
    launchUrl: undefined,
  });
  if (response && response.ok) {
    expect(response.data?.runtime).toEqual({
      platform: 'android',
      metroHost: '10.0.0.10',
      metroPort: 8081,
      bundleUrl: undefined,
      launchUrl: undefined,
    });
  }
});

test('open runtime payload clears stale applied transport hints before launch', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-open-clear';
  sessionStore.setRuntimeHints(sessionName, {
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
  });
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.demo',
    appName: 'Demo',
  });

  const callOrder: string[] = [];

  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  mockClearRuntimeHints.mockImplementation(async ({ device, appId }) => {
    callOrder.push(`clear:${device.id}:${appId}`);
  });
  mockApplyRuntimeHints.mockImplementation(async () => {
    callOrder.push('runtime');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    callOrder.push(`dispatch:${command}:${positionals.join('|')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: {},
      runtime: {
        launchUrl: 'myapp://fresh',
      },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(callOrder).toEqual([
    'clear:emulator-5554:com.example.demo',
    'runtime',
    'dispatch:open:Demo',
    'dispatch:open:myapp://fresh',
  ]);
  expect(sessionStore.getRuntimeHints(sessionName)).toEqual({
    platform: 'android',
    metroHost: undefined,
    metroPort: undefined,
    bundleUrl: undefined,
    launchUrl: 'myapp://fresh',
  });
  if (response && response.ok) {
    expect(response.data?.runtime).toEqual({
      platform: 'android',
      metroHost: undefined,
      metroPort: undefined,
      bundleUrl: undefined,
      launchUrl: 'myapp://fresh',
    });
  }
});

test('open runtime payload rejects invalid metro port before app launch', async () => {
  const sessionStore = makeSessionStore();
  let dispatchCalls = 0;

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  mockDispatch.mockImplementation(async () => {
    dispatchCalls += 1;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'runtime-open-invalid-port',
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: {
        metroHost: '10.0.0.10',
        metroPort: 70000,
      },
    },
    sessionName: 'runtime-open-invalid-port',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe(
      'Invalid runtime metroPort: 70000. Use an integer between 1 and 65535.',
    );
  }
  expect(dispatchCalls).toBe(0);
});

test('open runtime payload rejects malformed runtime objects without mutating session state', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-open-malformed';
  sessionStore.setRuntimeHints(sessionName, {
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
  });

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: 'not-an-object' as unknown as DaemonRequest['runtime'],
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe('open runtime must be an object.');
  }
  expect(sessionStore.getRuntimeHints(sessionName)).toEqual({
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
  });
});

test('open runtime payload does not persist replacement when launch fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-open-launch-fails';
  sessionStore.setRuntimeHints(sessionName, {
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
    launchUrl: 'myapp://stale',
  });

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  mockApplyRuntimeHints.mockResolvedValue(undefined);
  mockDispatch.mockRejectedValue(new AppError('COMMAND_FAILED', 'launch failed'));

  await expect(
    handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'open',
        positionals: ['Demo'],
        flags: { platform: 'android' },
        runtime: {
          metroHost: '127.0.0.1',
          metroPort: 9090,
        },
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  ).rejects.toThrow(expect.objectContaining({ code: 'COMMAND_FAILED', message: 'launch failed' }));

  expect(sessionStore.getRuntimeHints(sessionName)).toEqual({
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
    launchUrl: 'myapp://stale',
  });
});

test('open --metro-port alone defaults the host to 10.0.2.2 on an Android emulator', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-open-port-only-android';
  const runtimeApplyCalls: Array<{ host?: string; port?: number }> = [];

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5556',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  mockApplyRuntimeHints.mockImplementation(async ({ runtime }) => {
    runtimeApplyCalls.push({ host: runtime?.metroHost, port: runtime?.metroPort });
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: { metroPort: 8084 },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(runtimeApplyCalls).toEqual([{ host: '10.0.2.2', port: 8084 }]);
  expect(sessionStore.getRuntimeHints(sessionName)?.metroHost).toBe('10.0.2.2');
  expect(sessionStore.getRuntimeHints(sessionName)?.metroPort).toBe(8084);
});

test('open --metro-port alone defaults the host to 127.0.0.1 on an iOS simulator', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-open-port-only-ios';
  const runtimeApplyCalls: Array<{ host?: string; port?: number }> = [];

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });
  mockApplyRuntimeHints.mockImplementation(async ({ runtime }) => {
    runtimeApplyCalls.push({ host: runtime?.metroHost, port: runtime?.metroPort });
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'ios' },
      runtime: { metroPort: 8084 },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(runtimeApplyCalls).toEqual([{ host: '127.0.0.1', port: 8084 }]);
  expect(sessionStore.getRuntimeHints(sessionName)?.metroHost).toBe('127.0.0.1');
});

test('open --metro-port alone stays host-ambiguous on a physical Android device', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-open-port-only-physical';
  const runtimeApplyCalls: Array<{ host?: string; port?: number }> = [];

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'R5CN30',
    name: 'Galaxy',
    kind: 'device',
    booted: true,
  });
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  mockApplyRuntimeHints.mockImplementation(async ({ runtime }) => {
    runtimeApplyCalls.push({ host: runtime?.metroHost, port: runtime?.metroPort });
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: { metroPort: 8084 },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(runtimeApplyCalls).toEqual([{ host: undefined, port: 8084 }]);
  expect(sessionStore.getRuntimeHints(sessionName)?.metroHost).toBeUndefined();
  expect(sessionStore.getRuntimeHints(sessionName)?.metroPort).toBe(8084);
});

test('open --relaunch allows Android package names ending with apk-like suffix', async () => {
  const sessionStore = makeSessionStore();
  const dispatchCalls: Array<{ command: string; positionals: string[] }> = [];

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    dispatchCalls.push({ command, positionals });
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['com.example.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(dispatchCalls[0]?.command).toBe('close');
  expect(dispatchCalls[0]?.positionals).toEqual(['com.example.apk']);
  expect(dispatchCalls[1]?.command).toBe('open');
  expect(dispatchCalls[1]?.positionals).toEqual(['com.example.apk']);
});
