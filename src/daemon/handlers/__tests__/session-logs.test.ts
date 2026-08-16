import { beforeEach, expect, test, vi } from 'vitest';
import {
  applicationLifecycleOperationFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
  type AppLogRuntimeOperations,
  type CleanupOutcome,
  type DeviceBinding,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../../__tests__/test-utils/runtime-operation-facts.ts';
import { createAppLogStartResult, createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { createTestAppLogLiveHandle } from '../../../__tests__/test-utils/app-log-live-handle.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  createAppLogAdmissionLedger,
  type AppLogAdmissionLedger,
} from '../../app-log-admission-ledger.ts';
import { handleSessionCommands } from './session-command-harness.ts';
import { appLogResourceStore } from '../../app-log-resource-store.ts';
import type { BindDeviceRuntime } from '../../request-runtime-binding.ts';
import type { SessionStore } from '../../session-store.ts';
import {
  makeSession,
  makeSessionStore,
  makeTestAppLogResource,
  noopInvoke,
} from './session-test-harness.ts';

const DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone',
  kind: 'simulator',
  booted: true,
};

type RuntimeHarness = ReturnType<typeof createRuntimeHarness>;

let runtime: RuntimeHarness;
let admissionLedger: AppLogAdmissionLedger;

beforeEach(() => {
  runtime = createRuntimeHarness();
  admissionLedger = createAppLogAdmissionLedger();
});

test('logs requires an active session', async () => {
  const response = await runLogs(makeSessionStore(), 'missing', ['path']);
  expect(response?.ok).toBe(false);
  if (response?.ok === false) expect(response.error.code).toBe('SESSION_NOT_FOUND');
  expect(runtime.bind).not.toHaveBeenCalled();
});

test('logs rejects an invalid plan before binding a runtime', async () => {
  const { sessionStore, sessionName } = openSession();
  const response = await runLogs(sessionStore, sessionName, ['invalid'], {}, runtime.bindDevice);
  expect(response?.ok).toBe(false);
  if (response?.ok === false) expect(response.error.code).toBe('INVALID_ARGS');
  expect(runtime.boundUses()).toEqual([{ required: [], preferred: ['appLogInspect'] }]);
});

test('logs preserves whole-command unsupported precedence before parsing the action', async () => {
  runtime = createRuntimeHarness({ inspectAvailable: false });
  const { sessionStore, sessionName } = openSession();
  const response = await runLogs(sessionStore, sessionName, ['invalid'], {}, runtime.bindDevice);
  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'logs is not supported on this device',
      hint: 'Use a runtime with app-log support.',
    },
  });
  expect(runtime.boundUses()).toEqual([{ required: [], preferred: ['appLogInspect'] }]);
});

test('logs path binds only inspect and preserves public status projection', async () => {
  const { sessionStore, sessionName } = openSession();
  const response = await runLogs(sessionStore, sessionName, ['path'], {}, runtime.bindDevice);
  expect(response).toMatchObject({
    ok: true,
    data: { active: false, state: 'inactive', backend: 'ios-simulator' },
  });
  expect(runtime.boundUses()).toEqual([
    { required: [], preferred: ['appLogInspect'] },
    { required: ['appLogInspect'], preferred: [] },
  ]);
  expect(runtime.inspect).toHaveBeenCalledOnce();
});

test('logs doctor binds only doctor and merges live-state notes', async () => {
  const { sessionStore, sessionName } = openSession();
  const session = sessionStore.get(sessionName)!;
  sessionStore.set(sessionName, {
    ...session,
    appLog: makeTestAppLogResource(session, {
      backend: 'ios-simulator',
      state: 'ended',
    }),
  });
  const response = await runLogs(sessionStore, sessionName, ['doctor'], {}, runtime.bindDevice);
  expect(response).toMatchObject({
    ok: true,
    data: {
      backend: 'ios-simulator',
      state: 'ended',
      checks: { simulatorLogStream: true },
    },
  });
  expect(runtime.boundUses()).toEqual([
    { required: [], preferred: ['appLogInspect'] },
    { required: ['appLogInspect', 'appLogDoctor'], preferred: [] },
  ]);
});

test.each([
  { action: ['mark', 'checkpoint'], expected: { marked: true } },
  { action: ['clear'], expected: { cleared: true } },
] as const)(
  'logs $action gates support and binds its exact inspect use',
  async ({ action, expected }) => {
    const { sessionStore, sessionName } = openSession();
    const response = await runLogs(sessionStore, sessionName, [...action], {}, runtime.bindDevice);
    expect(response).toMatchObject({ ok: true, data: expected });
    expect(runtime.boundUses()).toEqual([
      { required: [], preferred: ['appLogInspect'] },
      { required: ['appLogInspect'], preferred: [] },
    ]);
  },
);

test('logs stop uses the adopted handle after the required support bind', async () => {
  const { sessionStore, sessionName } = openSession();
  await expectStarted(await runLogs(sessionStore, sessionName, ['start'], {}, runtime.bindDevice));
  runtime.resetUses();
  const response = await runLogs(sessionStore, sessionName, ['stop'], {}, runtime.bindDevice);
  expect(response).toMatchObject({ ok: true, data: { stopped: true } });
  expect(runtime.boundUses()).toEqual([
    { required: [], preferred: ['appLogInspect'] },
    { required: ['appLogInspect'], preferred: [] },
  ]);
  expect(runtime.finish).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)?.appLog).toBeUndefined();
  expect(readRecord(sessionStore, sessionName)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
});

test('logs start persists the durable envelope before adopting the live handle', async () => {
  const { sessionStore, sessionName } = openSession();
  await expectStarted(await runLogs(sessionStore, sessionName, ['start'], {}, runtime.bindDevice));
  expect(runtime.start.mock.calls[0]?.[0].appBundleId).toBe('com.example.app');
  expect(sessionStore.get(sessionName)?.appLog).toBeDefined();
  expect(readRecord(sessionStore, sessionName)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', sessionId: sessionName, metadata: { phase: 'active' } },
  });
  expect(runtime.boundUses()).toEqual([
    { required: [], preferred: ['appLogInspect'] },
    { required: ['appLogInspect', 'appLogStart'], preferred: [] },
  ]);
});

test.each([
  { action: ['start'], message: /logs start requires an app session/ },
  {
    action: ['clear'],
    flags: { restart: true },
    message: /logs clear --restart requires an app session/,
  },
] as const)(
  '$action proves the app session before binding start operations',
  async ({ action, flags = {}, message }) => {
    const { sessionStore, sessionName } = openSession();
    const session = sessionStore.get(sessionName)!;
    sessionStore.set(sessionName, { ...session, appBundleId: undefined });

    const response = await runLogs(
      sessionStore,
      sessionName,
      [...action],
      flags,
      runtime.bindDevice,
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    if (response?.ok === false) expect(response.error.message).toMatch(message);
    expect(runtime.boundUses()).toEqual([{ required: [], preferred: ['appLogInspect'] }]);
    expect(runtime.start).not.toHaveBeenCalled();
  },
);

test('logs clear --restart finishes generation one before adopting generation two', async () => {
  const { sessionStore, sessionName } = openSession();
  await expectStarted(await runLogs(sessionStore, sessionName, ['start'], {}, runtime.bindDevice));
  const response = await runLogs(
    sessionStore,
    sessionName,
    ['clear'],
    { restart: true },
    runtime.bindDevice,
  );
  expect(response).toMatchObject({ ok: true, data: { cleared: true, restarted: true } });
  expect(readRecord(sessionStore, sessionName)).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'open',
      fence: { generation: 2 },
      metadata: { phase: 'active' },
    },
  });
});

test('cancellation after native start persists recovery truth and cleans the pending handle', async () => {
  const { sessionStore, sessionName } = openSession();
  const response = await runLogs(
    sessionStore,
    sessionName,
    ['start'],
    {},
    runtime.bindDevice,
    () => {
      throw new AppError('CANCELED', 'request canceled');
    },
  );
  expect(response?.ok).toBe(false);
  expect(runtime.forceCleanup).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)?.appLog).toBeUndefined();
  expect(readRecord(sessionStore, sessionName)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
});

test('rejected pending cleanup retains cleanup-pending record and blocks replacement', async () => {
  runtime.forceCleanup.mockResolvedValue({
    status: 'cleanup-pending',
    reason: 'cleanup-unconfirmed',
  });
  const { sessionStore, sessionName } = openSession();
  const canceled = await runLogs(
    sessionStore,
    sessionName,
    ['start'],
    {},
    runtime.bindDevice,
    () => {
      throw new AppError('CANCELED', 'request canceled');
    },
  );
  expect(canceled?.ok).toBe(false);
  expect(readRecord(sessionStore, sessionName)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'cleanup-pending' } },
  });
  runtime.bind.mockClear();
  const replacement = await runLogs(sessionStore, sessionName, ['start'], {}, runtime.bindDevice);
  expect(replacement?.ok).toBe(false);
  if (replacement?.ok === false) {
    expect(replacement.error.details?.reason).toBe('cleanup-unconfirmed');
  }
  expect(runtime.start).not.toHaveBeenCalledTimes(2);
});

test('post-transfer SessionStore failure disposes the transferred handle and preserves primary error', async () => {
  const { sessionStore, sessionName } = openSession();
  const primary = new Error('store adoption failed');
  vi.spyOn(sessionStore, 'set').mockImplementationOnce(() => {
    throw primary;
  });
  const response = await runLogs(sessionStore, sessionName, ['start'], {}, runtime.bindDevice);
  expect(response?.ok).toBe(false);
  if (response?.ok === false) expect(response.error.message).toBe(primary.message);
  expect(runtime.forceCleanup).toHaveBeenCalledOnce();
});

function openSession() {
  const sessionStore = makeSessionStore();
  const sessionName = 'logs-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, DEVICE),
    appBundleId: 'com.example.app',
  });
  return { sessionStore, sessionName };
}

async function runLogs(
  sessionStore: SessionStore,
  sessionName: string,
  positionals: string[],
  flags: Record<string, unknown> = {},
  bindDevice?: BindDeviceRuntime,
  throwIfCanceled?: () => void,
) {
  return await handleSessionCommands({
    req: { token: 't', session: sessionName, command: 'logs', positionals, flags },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    invoke: noopInvoke,
    bindDevice,
    appLogAdmissionLedger: admissionLedger,
    throwIfCanceled,
  });
}

async function expectStarted(response: Awaited<ReturnType<typeof runLogs>>) {
  expect(response).toMatchObject({ ok: true, data: { started: true } });
}

function readRecord(sessionStore: SessionStore, sessionName: string) {
  return appLogResourceStore.read(
    appLogResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName)),
  );
}

function createRuntimeHarness(options: { inspectAvailable?: boolean } = {}) {
  const owner = localRuntimeOwner('apple');
  const inspect = vi.fn(async () => ({ backend: 'ios-simulator' as const }));
  const doctor = vi.fn(async () => ({
    backend: 'ios-simulator' as const,
    checks: { simulatorLogStream: true },
    notes: [] as string[],
  }));
  const finish = vi.fn(async () => ({
    status: 'completed' as const,
    result: {
      backend: 'ios-simulator' as const,
      outputPath: '/tmp/app.log',
      completedAt: Date.now(),
    },
  }));
  const forceCleanup = vi.fn<() => Promise<CleanupOutcome>>(async () => ({
    status: 'cleaned',
  }));
  const start = vi.fn<AppLogRuntimeOperations['appLogStart']>(async (input) => {
    const handle = createTestAppLogLiveHandle({
      inspect: () => ({
        backend: 'ios-simulator',
        state: 'active',
        startedAt: 1_712_040_000_000,
      }),
      finish,
      forceCleanup,
    });
    const envelope = createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: input.sessionId,
      device: { id: DEVICE.id, family: DEVICE.platform, appleOs: 'ios', kind: DEVICE.kind },
      owner,
      fence: input.fence,
      lifecycle: 'open',
      descriptor: { version: 1, body: { outputPath: input.outputPath } },
    });
    return createAppLogStartResult(handle, envelope);
  });
  const operations: DeviceBinding<PlatformRuntimeOperations>['operations'] = {
    appLogInspect: inspect,
    appLogDoctor: doctor,
    appLogStart: start,
    appLogReattach: async () => ({ status: 'missing' }),
    appLogCleanup: async () => ({ status: 'cleaned' }),
    networkDump: async (input) => ({
      source: 'app-log',
      backend: 'ios-simulator',
      dump: {
        path: '/tmp/app.log',
        exists: false,
        scannedLines: 0,
        matchedLines: 0,
        entries: [],
        include: input.include,
        limits: {
          maxEntries: input.maxEntries,
          maxPayloadChars: input.maxPayloadChars,
          maxScanLines: input.maxScanLines,
        },
      },
      notes: [],
    }),
  };
  const uses: Array<{ required: readonly string[]; preferred: readonly string[] }> = [];
  const bind = vi.fn(
    async (device: DeviceInfo): Promise<DeviceBinding<PlatformRuntimeOperations>> => ({
      device,
      owner,
      facts: {
        device: {
          family: device.platform,
          appleOs: 'ios',
          kind: device.kind,
          providerMode: 'local',
        },
        operations: {
          appLogInspect:
            options.inspectAvailable === false
              ? {
                  available: false,
                  reason: 'owner-capability-missing',
                  hint: 'Use a runtime with app-log support.',
                }
              : { available: true },
          appLogDoctor: { available: true },
          appLogStart: { available: true },
          appLogReattach: { available: true },
          appLogCleanup: { available: true },
          appState: { available: false, reason: 'owner-capability-missing' },
          networkDump: { available: true },
          screenRecordingStart: unavailableRecording,
          screenRecordingReattach: unavailableRecording,
          screenRecordingCleanup: unavailableRecording,
          ensureReady: { available: true as const },
          bootTarget: { available: true as const },
          bootTargetHeadless: unavailableRecording,
          listApps: unavailableRecording,
          ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
          ...applicationLifecycleOperationFacts({
            resolveOpenTarget: unavailableRecording,
            prepareApplicationOpen: unavailableRecording,
            openApplication: unavailableRecording,
            applyRuntimeHints: unavailableRecording,
            clearRuntimeHints: unavailableRecording,
            closeApplication: unavailableRecording,
            finalizeApplicationClose: unavailableRecording,
            prepareAppleRunner: unavailableRecording,
            configureProviderPortReverse: unavailableRecording,
          }),
        },
      },
      operations,
      [Symbol.asyncDispose]: async () => {},
    }),
  );
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    uses.push(use);
    return narrowDeviceBinding(await bind(device), use);
  };
  return {
    bind,
    bindDevice,
    boundUses: () =>
      uses.map((use) => ({ required: [...use.required], preferred: [...use.preferred] })),
    resetUses: () => {
      uses.length = 0;
    },
    inspect,
    doctor,
    start,
    finish,
    forceCleanup,
  };
}

const unavailableRecording = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});
