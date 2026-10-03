import { test, expect, vi, beforeEach } from 'vitest';

import path from 'node:path';
import fs from 'node:fs';
import type {
  ApplicationLifecycleRuntimeOperations,
  OpenApplicationInput,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { DaemonRequest } from '../../../daemon-request.ts';
import {
  registerRequestAbort,
  markRequestCanceled,
  clearRequestAbortRegistration,
} from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';

const mockResolveTargetDevice = vi.hoisted(() => vi.fn());

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../../__tests__/device-selection-stub.ts');
  return {
    ...actual,
    resolveTargetDevice: mockResolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(mockResolveTargetDevice)),
  };
});
vi.mock('../../../device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('../../../../platform-runtime-runtime-hints.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../platform-runtime-runtime-hints.ts')>();
  return {
    ...actual,
    applyRuntimeHintValues: vi.fn(async () => {}),
    clearRuntimeHintValues: vi.fn(async () => {}),
  };
});
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return {
    ...actual,
    prewarmIosRunnerSession: vi.fn(),
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
} from '../../../handlers/__tests__/session-command-harness.ts';
import {
  applyRuntimeHintValues,
  clearRuntimeHintValues,
} from '../../../../platform-runtime-runtime-hints.ts';
import { resolveAndroidPackageForOpen } from '@agent-device/platform-android/mechanics';
import { dispatchApplicationLifecycleEffect } from '../../../__tests__/application-lifecycle-runtime-fixture.ts';
import {
  makeAndroidEmulator,
  makeSession,
  makeSessionStore,
  noopInvoke,
} from './session-open-runtime.fixtures.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

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
