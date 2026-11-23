import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { test, expect, vi, beforeEach } from 'vitest';

import path from 'node:path';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonRequest } from '../../../../core/daemon-request.ts';
import type { OpenApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';

const mockResolveTargetDevice = vi.hoisted(() => vi.fn());

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../../../__tests__/support/device-selection-stub.ts');
  return {
    ...actual,
    resolveTargetDevice: mockResolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(mockResolveTargetDevice)),
  };
});
vi.mock('../../../../core/device/device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return {
    ...actual,
    prewarmIosRunnerSession: vi.fn(),
    notifyIosRunnerAppRelaunched: vi.fn(async () => {}),
    stopIosRunnerSession: vi.fn(async () => {}),
  };
});
vi.mock('@agent-device/platform-apple/app-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-resolution')>();
  return { ...actual, resolveIosApp: vi.fn(async () => 'com.example.demo') };
});
vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    activateAndroidTestIme: vi.fn(async () => ({ activated: false })),
    resolveAndroidPackageForOpen: vi.fn(async () => undefined),
  };
});
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return { ...actual, readProcessStartTime: vi.fn(() => 'test-process-start') };
});

import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
} from '../../../../__tests__/support/handlers/session-command-harness.ts';
import {
  applyRuntimeHintsFixture,
  clearRuntimeHintsFixture,
  dispatchApplicationLifecycleEffect,
  resolveOpenTargetFixture,
} from '../../../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import { resolveAndroidPackageForOpen } from '@agent-device/platform-android/mechanics';
import { lifecycleRuntimeFacts } from '../../../../__tests__/support/application-lifecycle-runtime-harness.ts';
import {
  makeAndroidDevice,
  makeAndroidEmulator,
  makeAppleSimulator,
  makeSessionStore,
  noopInvoke,
} from './session-open-runtime.fixtures.ts';
import {
  mkdtempForTestSync,
  bindTestCommandHost,
  createTestHostEnvironment,
} from '@agent-device/test-kit';

bindTestCommandHost();

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const mockApplyRuntimeHints = vi.mocked(applyRuntimeHintsFixture);
const mockClearRuntimeHints = vi.mocked(clearRuntimeHintsFixture);
const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);
const mockResolveOpenTarget = vi.mocked(resolveOpenTargetFixture);
type BindDevice = Parameters<typeof handleSessionCommands>[0]['bindDevice'];

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockImplementation(async () => ({}));
  mockResolveAndroidPackage.mockResolvedValue(undefined);
  mockResolveOpenTarget.mockReset();
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
  // The open-target identity is a canned per-case answer at the port; what the real owners
  // resolve for an Android name is pinned in the composition lane.
  mockResolveOpenTarget.mockImplementation(async (_device, _direct, input) => ({
    appBundleId: 'com.example.demo',
    appName: input.target,
  }));
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
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'runtime-open',
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      internal: { webSession: { name: 'runtime-open' } },
    },
    sessionName: 'runtime-open',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).toHaveBeenCalledTimes(1);
  expect(mockResolveTargetDevice).toHaveBeenCalledWith(
    { platform: 'android' },
    {
      androidAvdSelection: 'running-only',
      appleSimulatorAppTarget: 'Demo',
      appDeviceTarget: 'Demo',
      webSession: { name: 'runtime-open' },
      env: process.env,
    },
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
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'runtime-open-false-fact',
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: { metroHost: '10.0.0.10', metroPort: 8081 },
    },
    sessionName: 'runtime-open-false-fact',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
  const launchConsolePath = path.join(mkdtempForTestSync('launch-console'), 'launch-console.log');
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
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'launch-console-runtime',
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'ios', launchConsole: launchConsolePath, launchArgs: ['-Flag', 'YES'] },
    },
    sessionName: 'launch-console-runtime',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: { metroPort: 8084 },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(runtimeApplyCalls).toEqual([{ host: '10.0.2.2', port: '8084' }]);
  expect(sessionStore.getRuntimeHints(sessionName)?.hints?.metroHost).toBe('10.0.2.2');
  expect(sessionStore.getRuntimeHints(sessionName)?.hints?.metroPort).toBe(8084);
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
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'ios' },
      runtime: { metroPort: 8084 },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(runtimeApplyCalls).toEqual([{ host: '127.0.0.1', port: '8084' }]);
  expect(sessionStore.getRuntimeHints(sessionName)?.hints?.metroHost).toBe('127.0.0.1');
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
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: { metroPort: 8084 },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(runtimeApplyCalls).toEqual([{ host: undefined, port: '8084' }]);
  expect(sessionStore.getRuntimeHints(sessionName)?.hints?.metroHost).toBeUndefined();
  expect(sessionStore.getRuntimeHints(sessionName)?.hints?.metroPort).toBe(8084);
});

test('open --relaunch allows Android package names ending with apk-like suffix', async () => {
  const sessionStore = makeSessionStore();
  const dispatchCalls: Array<{ command: string; positionals: string[] }> = [];

  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
  mockResolveAndroidPackage.mockResolvedValue('com.example.apk');
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    dispatchCalls.push({ command, positionals });
    return {};
  });

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['com.example.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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

async function runSessionCommand(
  sessionStore: ReturnType<typeof makeSessionStore>,
  req: Omit<DaemonRequest, 'token'>,
  bindDevice?: BindDevice,
): Promise<DaemonResponse> {
  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: { token: 't', ...req },
    sessionName: req.session!,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
    bindDevice,
  });
  if (!response) throw new Error(`${req.command} was not handled`);
  return response;
}

function recordRuntimeHintApplies(): Array<{ appId?: string; host?: string; port?: string }> {
  const applies: Array<{ appId?: string; host?: string; port?: string }> = [];
  mockApplyRuntimeHints.mockImplementation(async ({ appId, values }) => {
    applies.push({ appId, host: values.metroHost, port: values.metroPort });
  });
  return applies;
}

/** The launch reports `appBundleId`, as a platform does for the app it saw after the launch. */
function bindReportingOpenedApp(appBundleId: string): BindDevice {
  return async (device, use) => {
    const binding = await mockBindDeviceRuntime(device, use);
    return {
      ...binding,
      operations: {
        ...binding.operations,
        openApplication: async (input: OpenApplicationInput) => ({
          ...(await binding.operations.openApplication(input)),
          appBundleId,
        }),
      },
    };
  };
}

test.each([
  { storedBy: 'open flags', runtime: { metroPort: 8081 }, reopen: 'com.example.metro' },
  {
    storedBy: 'runtime hints set before the first open',
    runtime: undefined,
    reopen: 'com.example.metro',
  },
  { storedBy: 'open flags', runtime: { metroPort: 8081 }, reopen: 'myapp://home' },
])(
  'hints stored by $storedBy apply again on a reopen of $reopen when the open reports another app id',
  async ({ runtime, reopen }) => {
    const sessionStore = makeSessionStore();
    const session = 'runtime-hints-outcome-id';
    const applies = recordRuntimeHintApplies();
    mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
    if (!runtime) sessionStore.setRuntimeHints(session, { platform: 'android', metroPort: 8081 });
    const reportsOtherAppId = bindReportingOpenedApp('com.example.foreground');
    for (const [target, hints] of [
      ['com.example.metro', runtime],
      [reopen, undefined],
    ] as const) {
      const opened = await runSessionCommand(
        sessionStore,
        {
          session,
          command: 'open',
          positionals: [target],
          flags: { platform: 'android' },
          ...(hints ? { runtime: hints } : {}),
        },
        reportsOtherAppId,
      );
      expect(opened.ok).toBe(true);
    }

    expect(applies).toEqual([
      { appId: 'com.example.metro', host: '10.0.2.2', port: '8081' },
      { appId: 'com.example.metro', host: '10.0.2.2', port: '8081' },
    ]);
  },
);

test.each([
  { storedBy: 'open flags', runtime: { metroPort: 8082 } },
  { storedBy: 'runtime hints set before the first open', runtime: undefined },
])(
  'hints stored by $storedBy for a deep link bind to the app the launch reports',
  async ({ runtime }) => {
    const sessionStore = makeSessionStore();
    const session = 'runtime-hints-deep-link';
    const applies = recordRuntimeHintApplies();
    mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
    if (!runtime) sessionStore.setRuntimeHints(session, { platform: 'android', metroPort: 8082 });
    const open = async (target: string, hints?: DaemonRequest['runtime']) =>
      await runSessionCommand(
        sessionStore,
        {
          session,
          command: 'open',
          positionals: [target],
          flags: { platform: 'android' },
          ...(hints ? { runtime: hints } : {}),
        },
        bindReportingOpenedApp(target.includes('://') ? 'com.example.metro' : target),
      );

    const deepLink = await open('myapp://home', runtime);
    const settings = await open('com.android.settings');

    expect([deepLink.ok, settings.ok]).toEqual([true, true]);
    expect(applies).toEqual([{ appId: undefined, host: '10.0.2.2', port: '8082' }]);
    expect(sessionStore.getRuntimeHints(session)?.appId).toBe('com.example.metro');
  },
);

test.each([
  {
    label: 'an Android emulator',
    device: makeAndroidEmulator(),
    platform: 'android' as const,
    host: '10.0.2.2',
    otherApp: 'com.google.android.apps.photos',
  },
  {
    label: 'an iOS simulator',
    device: makeAppleSimulator(),
    platform: 'ios' as const,
    host: '127.0.0.1',
    otherApp: 'com.apple.mobileslideshow',
  },
])(
  'open hints apply again only to the app they were set for on $label',
  async ({ device, platform, host, otherApp }) => {
    const sessionStore = makeSessionStore();
    const session = `runtime-hints-per-app-${platform}`;
    const openedTargets: string[][] = [];
    const applies = recordRuntimeHintApplies();
    mockResolveTargetDevice.mockResolvedValue(device);
    mockDispatch.mockImplementation(async (_device, command, positionals) => {
      if (command === 'open') openedTargets.push(positionals);
      return {};
    });
    const open = async (target: string, runtime?: DaemonRequest['runtime']) =>
      await runSessionCommand(sessionStore, {
        session,
        command: 'open',
        positionals: [target],
        flags: { platform },
        ...(runtime ? { runtime } : {}),
      });

    const first = await open('com.example.metro', {
      metroPort: 8081,
      launchUrl: 'metroapp://dev-client',
    });
    const other = await open(otherApp);
    const again = await open('com.example.metro');

    expect([first.ok, other.ok, again.ok]).toEqual([true, true, true]);
    expect(applies).toEqual([
      { appId: 'com.example.metro', host, port: '8081' },
      { appId: 'com.example.metro', host, port: '8081' },
    ]);
    expect(openedTargets).toEqual([
      ['com.example.metro'],
      ['metroapp://dev-client'],
      [otherApp],
      ['com.example.metro'],
      ['metroapp://dev-client'],
    ]);
    expect(other.ok ? other.data?.runtime : 'failed').toBeUndefined();
    expect(again.ok ? again.data?.runtime : 'failed').toMatchObject({
      metroHost: host,
      metroPort: 8081,
      launchUrl: 'metroapp://dev-client',
    });
  },
);

test('hints stored before the first open bind to the app that open applied them to', async () => {
  const sessionStore = makeSessionStore();
  const session = 'runtime-hints-bind-on-first-open';
  const applies = recordRuntimeHintApplies();
  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
  sessionStore.setRuntimeHints(session, { platform: 'android', metroPort: 8081 });

  for (const target of ['com.example.metro', 'com.google.android.apps.photos']) {
    const response = await runSessionCommand(sessionStore, {
      session,
      command: 'open',
      positionals: [target],
      flags: { platform: 'android' },
    });
    expect(response.ok).toBe(true);
  }

  expect(applies).toEqual([{ appId: 'com.example.metro', host: '10.0.2.2', port: '8081' }]);
});

test('runtime set keeps edited hints bound to the app an open applied them to', async () => {
  const sessionStore = makeSessionStore();
  const session = 'runtime-hints-set-keeps-app';
  const applies = recordRuntimeHintApplies();
  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
  const open = async (target: string, runtime?: DaemonRequest['runtime']) =>
    await runSessionCommand(sessionStore, {
      session,
      command: 'open',
      positionals: [target],
      flags: { platform: 'android' },
      ...(runtime ? { runtime } : {}),
    });

  await open('com.example.metro', { metroPort: 8081 });
  const set = await runSessionCommand(sessionStore, {
    session,
    command: 'runtime',
    positionals: ['set'],
    flags: { metroPort: 8082 },
  });
  await open('com.google.android.apps.photos');
  await open('com.example.metro');

  expect(set.ok).toBe(true);
  expect(applies).toEqual([
    { appId: 'com.example.metro', host: '10.0.2.2', port: '8081' },
    { appId: 'com.example.metro', host: '10.0.2.2', port: '8082' },
  ]);
});

test.each([
  { clearer: 'close', req: { command: 'close', positionals: [], flags: {} } },
  { clearer: 'runtime clear', req: { command: 'runtime', positionals: ['clear'], flags: {} } },
  {
    clearer: 'an open with only a launch URL',
    req: {
      command: 'open',
      positionals: ['com.example.other'],
      flags: { platform: 'android' as const },
      runtime: { launchUrl: 'otherapp://home' },
    },
  },
])(
  '$clearer clears stored hints from the app they are bound to after another app opened',
  async ({ req }) => {
    const sessionStore = makeSessionStore();
    const session = 'runtime-hints-clear-bound-app';
    mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
    for (const [target, runtime] of [
      ['com.example.metro', { metroPort: 8081 }],
      ['com.google.android.apps.photos', undefined],
    ] as const) {
      const opened = await runSessionCommand(sessionStore, {
        session,
        command: 'open',
        positionals: [target],
        flags: { platform: 'android' },
        ...(runtime ? { runtime } : {}),
      });
      expect(opened.ok).toBe(true);
    }

    const response = await runSessionCommand(sessionStore, { session, ...req });

    expect(response.ok).toBe(true);
    expect(mockClearRuntimeHints).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        appId: 'com.example.metro',
        values: { metroHost: '10.0.2.2', metroPort: '8081' },
      }),
    );
  },
);

async function openTwiceWithHints(
  session: string,
  second: Readonly<{ target: string; metroPort: number }>,
  bindDevice?: BindDevice,
  first: DaemonRequest['runtime'] = { metroPort: 8081 },
): Promise<{
  store: ReturnType<typeof makeSessionStore>;
  effects: string[];
  secondOpen: unknown;
}> {
  const sessionStore = makeSessionStore();
  const effects: string[] = [];
  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
  mockApplyRuntimeHints.mockImplementation(async ({ appId, values }) => {
    effects.push(`apply ${appId} ${values.metroPort}`);
  });
  mockClearRuntimeHints.mockImplementation(async ({ appId, values }) => {
    effects.push(`clear ${appId} ${values.metroPort}`);
  });
  const open = async (target: string, runtime: DaemonRequest['runtime'], bind?: BindDevice) =>
    await runSessionCommand(
      sessionStore,
      { session, command: 'open', positionals: [target], flags: { platform: 'android' }, runtime },
      bind,
    );

  expect((await open('com.example.metro', first)).ok).toBe(true);
  const secondOpen = await open(second.target, { metroPort: second.metroPort }, bindDevice).catch(
    (error: unknown) => error,
  );
  return { store: sessionStore, effects, secondOpen };
}

test.each([
  {
    opened: 'another app with different hints',
    first: undefined,
    second: { target: 'com.example.other', metroPort: 8082 },
    effects: [
      'apply com.example.metro 8081',
      'apply com.example.other 8082',
      'clear com.example.metro 8081',
    ],
  },
  {
    opened: 'another app with the same hints',
    first: undefined,
    second: { target: 'com.example.other', metroPort: 8081 },
    effects: [
      'apply com.example.metro 8081',
      'apply com.example.other 8081',
      'clear com.example.metro 8081',
    ],
  },
  {
    opened: 'the same app with different hints',
    first: undefined,
    second: { target: 'com.example.metro', metroPort: 8082 },
    effects: ['apply com.example.metro 8081', 'apply com.example.metro 8082'],
  },
  {
    opened: 'another app after an open with only a launch URL',
    first: { launchUrl: 'metroapp://dev-client' },
    second: { target: 'com.example.other', metroPort: 8082 },
    effects: ['apply com.example.other 8082'],
  },
])(
  'an open of $opened clears the replaced hints only from another app',
  async ({ first, second, effects }) => {
    const result = await openTwiceWithHints('runtime-hints-replaced', second, undefined, first);

    expect((result.secondOpen as DaemonResponse).ok).toBe(true);
    expect(result.effects).toEqual(effects);
    expect(result.store.getRuntimeHints('runtime-hints-replaced')).toMatchObject({
      appId: second.target,
      hints: { metroPort: second.metroPort },
    });
  },
);

test('an open of another app reports a warning when the replaced hints cannot be removed', async () => {
  const sessionStore = makeSessionStore();
  const session = 'runtime-hints-replaced-clear-fails';
  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
  const open = async (target: string, metroPort: number) =>
    await runSessionCommand(sessionStore, {
      session,
      command: 'open',
      positionals: [target],
      flags: { platform: 'android' },
      runtime: { metroPort },
    });

  await open('com.example.metro', 8081);
  mockClearRuntimeHints.mockRejectedValueOnce(new Error('prefs write failed'));
  const opened = await open('com.example.other', 8082);

  expect(opened.ok).toBe(true);
  expect(opened.ok ? opened.data?.warnings : undefined).toEqual([
    expect.stringContaining('com.example.metro'),
  ]);
  expect(sessionStore.getRuntimeHints(session)).toMatchObject({
    appId: 'com.example.other',
    hints: { metroPort: 8082 },
  });
});

test('a failed launch of another app keeps the replaced hints on the app they were applied to', async () => {
  const launchFails: BindDevice = async (device, use) => {
    const binding = await mockBindDeviceRuntime(device, use);
    return {
      ...binding,
      operations: {
        ...binding.operations,
        openApplication: async () => {
          throw new Error('launch failed');
        },
      },
    };
  };

  const result = await openTwiceWithHints(
    'runtime-hints-replaced-failed-launch',
    { target: 'com.example.other', metroPort: 8082 },
    launchFails,
  );

  expect(result.secondOpen).toBeInstanceOf(Error);
  expect(result.effects).toEqual(['apply com.example.metro 8081']);
  expect(result.store.getRuntimeHints('runtime-hints-replaced-failed-launch')).toMatchObject({
    appId: 'com.example.metro',
    hints: { metroPort: 8081 },
  });
});

test('an open with new hints clears nothing for replaced hints that no open applied', async () => {
  const sessionStore = makeSessionStore();
  const session = 'runtime-hints-replaced-unbound';
  const applies = recordRuntimeHintApplies();
  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
  const open = async (target: string, runtime?: DaemonRequest['runtime']) =>
    await runSessionCommand(sessionStore, {
      session,
      command: 'open',
      positionals: [target],
      flags: { platform: 'android' },
      ...(runtime ? { runtime } : {}),
    });

  await open('com.google.android.apps.photos');
  const set = await runSessionCommand(sessionStore, {
    session,
    command: 'runtime',
    positionals: ['set'],
    flags: { metroPort: 8081 },
  });
  const opened = await open('com.example.metro', { metroPort: 8082 });

  expect([set.ok, opened.ok]).toEqual([true, true]);
  expect(mockClearRuntimeHints).not.toHaveBeenCalled();
  expect(applies).toEqual([{ appId: 'com.example.metro', host: '10.0.2.2', port: '8082' }]);
});
