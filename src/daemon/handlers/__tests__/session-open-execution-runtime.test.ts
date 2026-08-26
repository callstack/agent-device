import { test, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { DaemonRequest } from '../../types.ts';
import { AppError } from '@agent-device/kernel/errors';

const mockResolveTargetDevice = vi.hoisted(() => vi.fn());

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../__tests__/device-selection-stub.ts');
  return {
    ...actual,
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
vi.mock('../../../platforms/apple/core/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner-client.ts')>();
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
import {
  applyRuntimeHintValues,
  clearRuntimeHintValues,
} from '../../../platform-runtime-runtime-hints.ts';
import { resolveAndroidPackageForOpen } from '../../../platform-runtime-open-target.ts';
import { dispatchApplicationLifecycleEffect } from '../../__tests__/application-lifecycle-runtime-fixture.ts';
import {
  makeAndroidEmulator,
  makeSession,
  makeSessionStore,
  noopInvoke,
} from './session-open-runtime.fixtures.ts';

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const mockApplyRuntimeHints = vi.mocked(applyRuntimeHintValues);
const mockClearRuntimeHints = vi.mocked(clearRuntimeHintValues);
const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockImplementation(async () => ({}));
  mockResolveAndroidPackage.mockResolvedValue(undefined);
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
    port?: string;
    launchUrl?: string;
  }> = [];

  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  mockApplyRuntimeHints.mockImplementation(async ({ appId, values }) => {
    runtimeApplyCalls.push({
      appId,
      host: values.metroHost,
      port: values.metroPort,
      launchUrl: values.launchUrl,
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
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).toHaveBeenCalledTimes(1);
  expect(runtimeApplyCalls).toEqual([
    { appId: 'com.example.demo', host: '10.0.0.10', port: '8081', launchUrl: undefined },
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
    ...makeSession(sessionName, makeAndroidEmulator()),
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

  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
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

  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());

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

  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
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

// Regression: a first `open <app> <url>` used to collapse its positionals to the resolved target,
// silently dropping the deep link. The live Android smoke journey starts on a deep-linked route,
// so the dropped URL landed the app on its default screen and the landmark wait timed out.
test('a first open keeps both positionals so the deep link still reaches the app', async () => {
  const sessionStore = makeSessionStore();
  const dispatchCalls: Array<{ command: string; positionals: string[] }> = [];

  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    dispatchCalls.push({ command, positionals });
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'deep-link-open',
      command: 'open',
      positionals: ['com.example.demo', 'demo://agent-device/automation?event=cold.start'],
      flags: { platform: 'android' },
    },
    sessionName: 'deep-link-open',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(dispatchCalls).toEqual([
    {
      command: 'open',
      positionals: ['com.example.demo', 'demo://agent-device/automation?event=cold.start'],
    },
  ]);
});
