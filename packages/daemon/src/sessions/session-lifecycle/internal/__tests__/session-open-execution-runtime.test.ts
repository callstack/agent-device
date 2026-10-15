import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { test, expect, vi, beforeEach } from 'vitest';

import path from 'node:path';
import fs from 'node:fs';
import type {
  ApplicationLifecycleRuntimeOperations,
  OpenApplicationInput,
  PostOpenObservation,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { pendingSurfaceStabilization } from '../../../../core/deferred-interaction-outcome.ts';
import { lifecycleOperationsSpy } from '../../../../__tests__/support/lifecycle-operations-spy.ts';
import type { DaemonRequest } from '../../../../core/daemon-request.ts';
import {
  registerRequestAbort,
  markRequestCanceled,
  clearRequestAbortRegistration,
} from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';

const { mockResolveTargetDevice } = vi.hoisted(() => ({
  mockResolveTargetDevice: vi.fn(),
}));

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
  applicationLifecycleRuntimeFixture,
  applyRuntimeHintsFixture,
  clearRuntimeHintsFixture,
  dispatchApplicationLifecycleEffect,
  resolveOpenTargetFixture,
  type LifecycleOperationsLoader,
} from '../../../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import { resolveAndroidPackageForOpen } from '@agent-device/platform-android/mechanics';
import {
  makeAndroidEmulator,
  makeAppleSimulator,
  makeSession,
  makeSessionStore,
  noopInvoke,
} from './session-open-runtime.fixtures.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const mockApplyRuntimeHints = vi.mocked(applyRuntimeHintsFixture);
const mockClearRuntimeHints = vi.mocked(clearRuntimeHintsFixture);
const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);
const mockResolveOpenTarget = vi.mocked(resolveOpenTargetFixture);

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
  // The open-target identity is a canned one-shot answer at the port; what the real owners
  // resolve for an Android name is pinned in the composition lane. One-shot so a later open
  // in this file falls back to the fixture's canonical `directResolve` answer instead of
  // inheriting this case's bundle id (a persistent implementation survives `clearAllMocks`).
  mockResolveOpenTarget.mockImplementationOnce(async (_device, _direct, input) => ({
    appBundleId: 'com.example.demo',
    appName: input.target,
  }));
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
  sessionStore.publish(sessionName, {
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: 'not-an-object' as unknown as DaemonRequest['runtime'],
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
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
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'deep-link-open',
      command: 'open',
      positionals: ['com.example.demo', 'demo://agent-device/automation?event=cold.start'],
      flags: { platform: 'android' },
    },
    sessionName: 'deep-link-open',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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

test('open reports the launch confirmation its platform answered', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator());
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  const bindDefault = mockBindDeviceRuntime.getMockImplementation();
  if (!bindDefault) throw new Error('the harness binds a default runtime');
  mockBindDeviceRuntime.mockImplementationOnce(async (device, use) => {
    const binding = await bindDefault(device, use);
    const operations = binding.operations as ApplicationLifecycleRuntimeOperations;
    return {
      ...binding,
      operations: {
        ...binding.operations,
        openApplication: async (input: OpenApplicationInput) => ({
          ...(await operations.openApplication(input)),
          launchConfirmation: 'accepted' as const,
        }),
      },
    };
  });

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'launch-confirmation-open',
      command: 'open',
      positionals: ['com.example.demo'],
      flags: { platform: 'android' },
    },
    sessionName: 'launch-confirmation-open',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) expect(response.data?.launchConfirmation).toBe('accepted');
});

function holdNativeOpen() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bindDefault = mockBindDeviceRuntime.getMockImplementation();
  if (!bindDefault) throw new Error('the harness binds a default runtime');
  mockBindDeviceRuntime.mockImplementationOnce(async (device, use) => {
    const binding = await bindDefault(device, use);
    const operations = binding.operations as ApplicationLifecycleRuntimeOperations;
    return {
      ...binding,
      operations: {
        ...binding.operations,
        openApplication: async (input: OpenApplicationInput) => {
          entered();
          await held;
          return await operations.openApplication(input);
        },
      },
    };
  });
  return { reached, release };
}

function invokeHeldOpen(
  sessionStore: ReturnType<typeof makeSessionStore>,
  req?: Partial<DaemonRequest>,
) {
  return handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      command: 'open',
      session: 'default',
      positionals: ['com.example.demo'],
      flags: { platform: 'android' },
      ...req,
    },
    sessionName: 'cwd:held-open:default',
    sessionStore,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    invoke: noopInvoke,
  });
}

test('reopen publishes into the latest record of the same lifetime after native launch', async () => {
  const store = makeSessionStore();
  const session = makeSession('default', makeAndroidEmulator());
  const ref = store.publish('cwd:held-open:default', session);
  const native = holdNativeOpen();
  const pending = invokeHeldOpen(store);
  await native.reached;
  store.update(ref, { recordOnlySession: true });
  native.release();
  expect((await pending)?.ok).toBe(true);
  expect(store.lookup(ref.address)?.lifetime).toBe(ref.lifetime);
  expect(store.requireCurrent(ref).recordOnlySession).toBe(true);
  expect(store.requireCurrent(ref).createdAt).toBe(session.createdAt);
  expect(store.requireCurrent(ref).name).toBe('default');
});

test('a retired reopen cannot write hints or actions to the same record republished as a successor', async () => {
  const store = makeSessionStore();
  const session = makeSession('default', makeAndroidEmulator());
  const ref = store.publish('cwd:held-open:default', session);
  const native = holdNativeOpen();
  const pending = invokeHeldOpen(store, { runtime: { metroHost: 'new-host', metroPort: 9000 } });
  const refusal = expect(pending).rejects.toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'session_lifetime_ended' }),
    }),
  );
  await native.reached;
  store.retire(ref);
  const successor = store.publish(ref.address, session);
  store.setRuntimeHints(ref.address, { platform: 'android', metroHost: 'successor-host' });
  native.release();
  await refusal;
  expect(store.requireCurrent(successor)).toBe(session);
  expect(session.actions).toEqual([]);
  expect(store.getRuntimeHints(ref.address)?.metroHost).toBe('successor-host');
});

test('a provisional open refuses a successor before native launch', async () => {
  const store = makeSessionStore();
  const session = makeSession('default', makeAndroidEmulator());
  const ref = store.publish('cwd:held-open:default', session);
  await expect(
    invokeHeldOpen(store, {
      internal: {
        openLifecycle: {
          beforeDispatch: async () => {
            const provisional = store.requireCurrent(ref);
            store.retire(ref);
            store.publish(ref.address, provisional);
          },
        },
      },
    }),
  ).rejects.toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'session_lifetime_ended' }),
    }),
  );
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(store.get(ref.address)?.actions).toEqual([]);
});

test('fresh open completing after shutdown cannot publish or replace runtime hints', async () => {
  const store = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator('emulator-shutdown-open'));
  const native = holdNativeOpen();
  const pending = invokeHeldOpen(store, { runtime: { metroHost: 'new-host', metroPort: 9000 } });
  const refusal = expect(pending).rejects.toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'daemon_shutting_down' }),
    }),
  );
  await native.reached;
  store.closeAdmission();
  native.release();
  await refusal;
  expect(store.get('cwd:held-open:default')).toBeUndefined();
  expect(store.getRuntimeHints('cwd:held-open:default')).toBeUndefined();
});

test('cancelled fresh open does not publish after native launch returns', async () => {
  const store = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator('emulator-cancelled-open'));
  const native = holdNativeOpen();
  const requestId = 'cancelled-open-lifetime';
  const registration = registerRequestAbort(requestId);
  try {
    const pending = invokeHeldOpen(store, { meta: { requestId } });
    await native.reached;
    markRequestCanceled(requestId);
    native.release();
    expect(await pending).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'COMMAND_FAILED',
          details: expect.objectContaining({ reason: 'request_canceled' }),
        }),
      }),
    );
    expect(store.get('cwd:held-open:default')).toBeUndefined();
  } finally {
    clearRequestAbortRegistration(registration);
  }
});

test('fresh open does not publish when its artifact directory cannot be created', async () => {
  const store = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue(makeAndroidEmulator('emulator-directory-failed-open'));
  fs.writeFileSync(path.dirname(store.resolveSessionDir('cwd:held-open:default')), 'blocked');
  await expect(
    invokeHeldOpen(store, { runtime: { metroHost: 'new-host', metroPort: 9000 } }),
  ).rejects.toMatchObject({ code: 'ENOTDIR' });
  expect(mockDispatch).toHaveBeenCalled();
  expect(store.get('cwd:held-open:default')).toBeUndefined();
  expect(store.getRuntimeHints('cwd:held-open:default')).toBeUndefined();
});

for (const transition of ['rebuild', 'retire'] as const) {
  test(`foreground composition retains the published lifetime across ${transition}`, async () => {
    const store = makeSessionStore();
    mockResolveTargetDevice.mockResolvedValue(
      makeAndroidEmulator(`emulator-foreground-${transition}`),
    );
    const record = store.recordAction.bind(store);
    vi.spyOn(store, 'recordAction').mockImplementationOnce((recordedRef, entry) => {
      record(recordedRef, entry);
      const ref = store.lookup('cwd:held-open:default')!;
      queueMicrotask(() => {
        if (transition === 'rebuild') {
          store.update(ref, { recordOnlySession: true });
        } else {
          store.retire(ref);
          store.publish(ref.address, recordedRef.session);
        }
        mockInspectDeviceRuntimeFacts.mockClear();
      });
    });
    const response = await invokeHeldOpen(store, {
      flags: { platform: 'android', foreground: true },
    });
    expect(response?.ok).toBe(true);
    if (!response?.ok) throw new Error('open must remain successful');
    if (transition === 'retire') {
      expect(response.data?.initialSnapshotError).toEqual(
        expect.objectContaining({
          details: expect.objectContaining({ reason: 'session_lifetime_ended' }),
        }),
      );
      expect(mockInspectDeviceRuntimeFacts).not.toHaveBeenCalled();
      expect(store.get('cwd:held-open:default')?.snapshot).toBeUndefined();
    } else {
      expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalled();
      expect(store.get('cwd:held-open:default')?.recordOnlySession).toBe(true);
    }
  });
}

async function openIosApp(params: {
  sessionName: string;
  flags?: Record<string, unknown>;
  openApplication: ApplicationLifecycleRuntimeOperations['openApplication'];
}) {
  mockResolveTargetDevice.mockResolvedValue(makeAppleSimulator());
  const { loader } = lifecycleOperationsSpy({ openApplication: params.openApplication });
  return await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    lifecycleOperationsLoader: loader,
    req: {
      token: 't',
      session: params.sessionName,
      command: 'open',
      positionals: ['com.example.app', 'rne://screen-layout'],
      flags: { platform: 'ios', ...params.flags },
    },
    sessionName: params.sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore: makeSessionStore(),
    invoke: noopInvoke,
  });
}

test.each([
  { flags: { maestro: { prewarmRunnerBeforeOpen: true } }, expected: true },
  { flags: {}, expected: false },
])(
  'open hands the lifecycle prewarmRunnerBeforeOpen=$expected for flags $flags',
  async ({ flags, expected }) => {
    const openApplication = vi.fn<ApplicationLifecycleRuntimeOperations['openApplication']>(
      async () => ({ timing: {} }),
    );

    const response = await openIosApp({ sessionName: 'maestro-open-link', flags, openApplication });

    expect(response?.ok).toBe(true);
    expect(openApplication).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ prewarmRunnerBeforeOpen: expected }),
    );
  },
);

test('open reports the runner prewarm timing the lifecycle measured', async () => {
  const response = await openIosApp({
    sessionName: 'prewarm-timing-open',
    flags: { maestro: { prewarmRunnerBeforeOpen: true } },
    openApplication: async () => ({
      timing: {
        runnerPrewarmKind: 'session',
        runnerPrewarmScheduled: true,
        runnerPrewarmWaited: true,
      },
    }),
  });

  expect(response?.ok).toBe(true);
  expect((response as { data?: Record<string, unknown> }).data?.timing).toMatchObject({
    runnerPrewarmKind: 'session',
    runnerPrewarmScheduled: true,
    runnerPrewarmWaited: true,
  });
});

test('open rethrows a lifecycle open failure with its typed code, message, and hint', async () => {
  const prewarmFailure = new AppError(
    'COMMAND_FAILED',
    'Developer mode is disabled for Apple development tools',
    { hint: 'Run `sudo DevToolsSecurity -enable`.' },
  );

  await expect(
    openIosApp({
      sessionName: 'prewarm-failed-open',
      flags: { maestro: { prewarmRunnerBeforeOpen: true } },
      openApplication: async () => {
        throw prewarmFailure;
      },
    }),
  ).rejects.toBe(prewarmFailure);

  expect(prewarmFailure).toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Developer mode is disabled for Apple development tools',
    details: { hint: expect.stringContaining('DevToolsSecurity -enable') },
  });
  expect(mockDispatch).not.toHaveBeenCalled();
});

test.each([
  { target: 'Demo', expected: true },
  { target: 'myapp://screen/to', expected: false },
])(
  'open asks the lifecycle to warm the runner cache on cold boot only for an app target: $target',
  async ({ target, expected }) => {
    mockResolveTargetDevice.mockResolvedValue(makeAppleSimulator());
    const prepareApplicationOpen = vi.fn<
      ApplicationLifecycleRuntimeOperations['prepareApplicationOpen']
    >(async () => {});
    const { loader } = lifecycleOperationsSpy({ prepareApplicationOpen });

    const response = await handleSessionCommands({
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      lifecycleOperationsLoader: loader,
      req: {
        token: 't',
        session: 'cold-boot-prewarm-open',
        command: 'open',
        positionals: [target],
        flags: { platform: 'ios' },
        meta: { requestId: 'open-request' },
      },
      sessionName: 'cold-boot-prewarm-open',
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      sessionStore: makeSessionStore(),
      invoke: noopInvoke,
    });

    expect(response?.ok).toBe(true);
    expect(prepareApplicationOpen).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        prewarmRunnerOnColdBoot: expected,
        execution: expect.objectContaining({ requestId: 'open-request' }),
      }),
    );
  },
);

async function openReportingObservation(
  sessionName: string,
  postOpenObservation: PostOpenObservation,
) {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue(makeAppleSimulator());
  const loader: LifecycleOperationsLoader = async (device, signal, shutdownTarget) => {
    const base = await applicationLifecycleRuntimeFixture(device, signal, shutdownTarget);
    return Object.freeze({
      ...base,
      openApplication: async (input: OpenApplicationInput) => {
        const outcome = await base.openApplication(input);
        return { ...outcome, timing: { ...outcome.timing, postOpenObservation } };
      },
    });
  };

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    lifecycleOperationsLoader: loader,
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'ios' },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response?.ok).toBe(true);
  return sessionStore.get(sessionName);
}

test('a fresh iOS open that could not observe its app leaves the next capture to settle', async () => {
  const session = await openReportingObservation('unobserved-open', 'unobservable');

  expect(pendingSurfaceStabilization(session)?.action).toBe('open');
});

test('a fresh iOS open whose observation probe failed leaves the next capture to settle', async () => {
  const session = await openReportingObservation('probe-failed-open', 'probe-failed');

  expect(pendingSurfaceStabilization(session)?.action).toBe('open');
});

test('a fresh iOS open that observed its app leaves nothing pending', async () => {
  const session = await openReportingObservation('observed-open', 'observable');

  expect(pendingSurfaceStabilization(session)).toBeUndefined();
});
