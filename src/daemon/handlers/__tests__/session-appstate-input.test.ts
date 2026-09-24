import { test, expect } from 'vitest';
import * as path from 'node:path';
import {
  mockDispatch,
  mockResolveTargetDevice,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from './session-test-harness.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SessionState } from '../../session-state.ts';
import type { DaemonRequest } from '../../daemon-request.ts';
import { handleSessionCommands, mockInspectDeviceRuntimeFacts } from './session-command-harness.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { AppError } from '@agent-device/kernel/errors';
import type {
  AppStateRuntimeInput,
  AppStateRuntimeResult,
} from '@agent-device/contracts/app-state-runtime';
import {
  appStateUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type RuntimeFacts,
} from '@agent-device/contracts/platform-runtime';
import type { BindDeviceRuntime } from '../../request-runtime-binding.ts';

test('appstate on iOS requires active session on selected device', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 15',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.apple.Preferences',
    appName: 'Settings',
  });
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);
  mockDispatch.mockRejectedValue(new Error('snapshot dispatch should not run'));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'appstate',
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
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/requires an active session/i);
  }
});

test('appstate returns session appName when bundle id is unavailable', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'sim';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appName: 'Maps',
  });

  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);
  mockDispatch.mockRejectedValue(new Error('snapshot dispatch should not run'));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'appstate',
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
  if (response && response.ok) {
    expect(response.data?.platform).toBe('ios');
    expect(response.data?.appName).toBe('Maps');
    expect(response.data?.appBundleId).toBe(undefined);
    expect(response.data?.source).toBe('session');
    expect(response.data?.device_udid).toBe('sim-1');
    expect(response.data?.ios_simulator_device_set).toBe(null);
  }
});

test('appstate fails when iOS session has no tracked app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'sim';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
  );

  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'appstate',
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
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/no foreground app is tracked/i);
  }
});

test('appstate without session on iOS selector returns SESSION_NOT_FOUND', async () => {
  const sessionStore = makeSessionStore();
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
      session: 'default',
      command: 'appstate',
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
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
  }
});

test('appstate with explicit missing session returns SESSION_NOT_FOUND', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'sim',
      command: 'appstate',
      positionals: [],
      flags: { session: 'sim', platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'sim',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/no active session "sim"/i);
    expect(response.error.message).not.toMatch(/omit --session/i);
  }
});

test('clipboard requires an active session or explicit device selector', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'clipboard',
      positionals: ['read'],
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
    expect(response.error.message).toMatch(
      /clipboard requires an active session or an explicit device selector/i,
    );
  }
});

test('clipboard rejects unsupported iOS physical devices', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
  );

  mockDispatch.mockRejectedValue(new Error('dispatch should not run for unsupported targets'));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'clipboard',
      positionals: ['read'],
      flags: {},
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/clipboard is not supported on this device/i);
  }
});

const IOS_SESSION_DEVICE: SessionState['device'] = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
};

/** An Apple owner that admits the appstate read and answers it with `read`. */
function appleAppStateRuntime(
  read: (input: AppStateRuntimeInput | undefined) => Promise<AppStateRuntimeResult>,
): {
  inspectFacts: (device: DeviceInfo) => Promise<RuntimeFacts<PlatformRuntimeOperations>>;
  bindDevice: BindDeviceRuntime;
} {
  const factsFor = async (device: DeviceInfo): Promise<RuntimeFacts<PlatformRuntimeOperations>> => {
    const base = await mockInspectDeviceRuntimeFacts(device);
    return { ...base, operations: { ...base.operations, appState: { available: true } } };
  };
  return {
    inspectFacts: factsFor,
    bindDevice: async (selected, use) => {
      const binding: DeviceBinding<PlatformRuntimeOperations> = {
        device: selected,
        owner: localRuntimeOwner('apple'),
        facts: await factsFor(selected),
        operations: {
          ensureReady: async () => selected,
          appState: read,
        },
        [Symbol.asyncDispose]: async () => undefined,
      };
      return narrowDeviceBinding(binding, use);
    },
  };
}

function iosSessionRequest(sessionName: string): DaemonRequest {
  return {
    token: 't',
    session: sessionName,
    command: 'appstate',
    positionals: [],
    flags: { platform: 'ios', device: 'iPhone 17 Pro' },
  };
}

test('appstate on iOS reads the session app state from the runner when its owner admits it', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'sim';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, IOS_SESSION_DEVICE),
    appBundleId: 'dev.e2e.benchmark',
    appName: 'Benchmark',
  });
  mockResolveTargetDevice.mockResolvedValue(IOS_SESSION_DEVICE);
  const asked: Array<AppStateRuntimeInput | undefined> = [];
  const runtime = appleAppStateRuntime(async (input) => {
    asked.push(input);
    return { applicationState: 'runningBackground' };
  });

  const response = await handleSessionCommands({
    req: iosSessionRequest(sessionName),
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
    ...runtime,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.appBundleId).toBe('dev.e2e.benchmark');
    expect(response.data?.state).toBe('runningBackground');
    expect(response.data?.source).toBe('runner');
  }
  // The read is about the session app, and the use it went through is the appstate use.
  expect(asked).toEqual([{ appBundleId: 'dev.e2e.benchmark' }]);
  expect(appStateUse.required).toEqual(['ensureReady', 'appState']);
});

test('appstate on iOS keeps the session answer, with no state, when no runner is live to ask', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'sim';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, IOS_SESSION_DEVICE),
    appBundleId: 'dev.e2e.benchmark',
    appName: 'Benchmark',
  });
  mockResolveTargetDevice.mockResolvedValue(IOS_SESSION_DEVICE);
  const runtime = appleAppStateRuntime(async () => ({}));

  const response = await handleSessionCommands({
    req: iosSessionRequest(sessionName),
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
    ...runtime,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.source).toBe('session');
    expect(response.data).not.toHaveProperty('state');
  }
});

test('appstate on iOS keeps the session answer, with no state, when the runner cannot read one', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'sim';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, IOS_SESSION_DEVICE),
    appBundleId: 'dev.e2e.benchmark',
    appName: 'Benchmark',
  });
  mockResolveTargetDevice.mockResolvedValue(IOS_SESSION_DEVICE);
  const runtime = appleAppStateRuntime(async () => {
    throw new AppError('COMMAND_FAILED', 'runner is busy');
  });

  const response = await handleSessionCommands({
    req: iosSessionRequest(sessionName),
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
    ...runtime,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.appName).toBe('Benchmark');
    expect(response.data?.source).toBe('session');
    expect(response.data).not.toHaveProperty('state');
  }
});
