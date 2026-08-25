import { test, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const mockResolveTargetDevice = vi.hoisted(() => vi.fn());

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../__tests__/device-selection-stub.ts');
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
    resolveTargetDevice: mockResolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(mockResolveTargetDevice)),
  };
});
vi.mock('../../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('../../../platform-runtime-runtime-hints.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platform-runtime-runtime-hints.ts')>();
  return {
    ...actual,
    applyRuntimeHintValues: vi.fn(async () => {}),
    clearRuntimeHintValues: vi.fn(async () => {}),
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
vi.mock('../../../platform-runtime-open-target.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform-runtime-open-target.ts')>();
  return { ...actual, resolveAndroidPackageForOpen: vi.fn(async () => undefined) };
});
vi.mock('../../../platforms/android/ime-lifecycle.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/ime-lifecycle.ts')>();
  return { ...actual, activateAndroidTestIme: vi.fn(async () => ({ activated: false })) };
});
vi.mock('../../../utils/host-process.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/host-process.ts')>();
  return { ...actual, readProcessStartTime: vi.fn(() => 'test-process-start') };
});

import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
} from './session-command-harness.ts';
import { applyRuntimeHintValues } from '../../../platform-runtime-runtime-hints.ts';
import { resolveAndroidPackageForOpen } from '../../../platform-runtime-open-target.ts';
import { dispatchApplicationLifecycleEffect } from '../../__tests__/application-lifecycle-runtime-fixture.ts';
import { lifecycleRuntimeFacts } from './application-lifecycle-runtime-harness.ts';
import {
  makeAndroidDevice,
  makeAndroidEmulator,
  makeAppleSimulator,
  makeSessionStore,
  noopInvoke,
} from './session-open-runtime.fixtures.ts';

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const mockApplyRuntimeHints = vi.mocked(applyRuntimeHintValues);
const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);

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
  const runtimeApplyCalls: Array<{ appId?: string; host?: string; port?: string }> = [];
  const callOrder: string[] = [];

  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  mockApplyRuntimeHints.mockImplementation(async ({ appId, values }) => {
    callOrder.push('runtime');
    runtimeApplyCalls.push({
      appId,
      host: values.metroHost,
      port: values.metroPort,
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
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).toHaveBeenCalledTimes(1);
  expect(mockResolveTargetDevice).toHaveBeenCalledWith(
    { platform: 'android' },
    { appleSimulatorAppTarget: 'Demo' },
  );
  expect(callOrder).toEqual(['runtime', 'dispatch:open', 'dispatch:open']);
  expect(runtimeApplyCalls).toEqual([
    { appId: 'com.example.demo', host: '10.0.0.10', port: '8081' },
  ]);
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

test('open rejects a false runtime-hints fact before its one implementation bind', async () => {
  const sessionStore = makeSessionStore();
  const device = makeAndroidEmulator();
  mockResolveTargetDevice.mockResolvedValue(device);
  mockInspectDeviceRuntimeFacts.mockImplementationOnce(async (candidate) => {
    const facts = lifecycleRuntimeFacts(candidate);
    return {
      ...facts,
      operations: {
        ...facts.operations,
        applyRuntimeHints: {
          available: false as const,
          reason: 'unsupported-provider-mode' as const,
          hint: 'Runtime hints are unavailable for this exact provider-owned cell.',
        },
      },
    };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'runtime-open-false-fact',
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: { metroHost: '10.0.0.10', metroPort: 8081 },
    },
    sessionName: 'runtime-open-false-fact',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'UNSUPPORTED_OPERATION', message: 'open is not supported on this device' },
  });
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(mockApplyRuntimeHints).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(sessionStore.get('runtime-open-false-fact')).toBeUndefined();
});

test('open applies launch-only flags only to the direct app launch before runtime launchUrl', async () => {
  const sessionStore = makeSessionStore();
  const launchConsolePath = path.join(os.tmpdir(), 'launch-console.log');
  const dispatchCalls: Array<{
    command: string;
    positionals: string[];
    launchConsole?: string;
    launchArgs?: readonly string[];
  }> = [];

  sessionStore.setRuntimeHints('launch-console-runtime', {
    platform: 'ios',
    launchUrl: 'myapp://dev-client',
  });
  mockResolveTargetDevice.mockResolvedValue({ ...makeAppleSimulator(), name: 'iPhone 15' });
  mockDispatch.mockImplementation(async (_device, command, positionals, _outPath, context) => {
    dispatchCalls.push({
      command,
      positionals,
      launchConsole: context?.launchConsole,
      launchArgs: context?.launchArgs,
    });
    return undefined;
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

test('open --metro-port alone defaults the host to 10.0.2.2 on an Android emulator', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-open-port-only-android';
  const runtimeApplyCalls: Array<{ host?: string; port?: string }> = [];

  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator('emulator-5556'));
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  mockApplyRuntimeHints.mockImplementation(async ({ values }) => {
    runtimeApplyCalls.push({ host: values.metroHost, port: values.metroPort });
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
  expect(runtimeApplyCalls).toEqual([{ host: '10.0.2.2', port: '8084' }]);
  expect(sessionStore.getRuntimeHints(sessionName)?.metroHost).toBe('10.0.2.2');
  expect(sessionStore.getRuntimeHints(sessionName)?.metroPort).toBe(8084);
});

test('open --metro-port alone defaults the host to 127.0.0.1 on an iOS simulator', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-open-port-only-ios';
  const runtimeApplyCalls: Array<{ host?: string; port?: string }> = [];

  mockResolveTargetDevice.mockResolvedValue(makeAppleSimulator());
  mockApplyRuntimeHints.mockImplementation(async ({ values }) => {
    runtimeApplyCalls.push({ host: values.metroHost, port: values.metroPort });
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
  expect(runtimeApplyCalls).toEqual([{ host: '127.0.0.1', port: '8084' }]);
  expect(sessionStore.getRuntimeHints(sessionName)?.metroHost).toBe('127.0.0.1');
});

test('open --metro-port alone stays host-ambiguous on a physical Android device', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-open-port-only-physical';
  const runtimeApplyCalls: Array<{ host?: string; port?: string }> = [];

  mockResolveTargetDevice.mockResolvedValue(makeAndroidDevice());
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  mockApplyRuntimeHints.mockImplementation(async ({ values }) => {
    runtimeApplyCalls.push({ host: values.metroHost, port: values.metroPort });
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
  expect(runtimeApplyCalls).toEqual([{ host: undefined, port: '8084' }]);
  expect(sessionStore.getRuntimeHints(sessionName)?.metroHost).toBeUndefined();
  expect(sessionStore.getRuntimeHints(sessionName)?.metroPort).toBe(8084);
});

test('open --relaunch allows Android package names ending with apk-like suffix', async () => {
  const sessionStore = makeSessionStore();
  const dispatchCalls: Array<{ command: string; positionals: string[] }> = [];

  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
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
