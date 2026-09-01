import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import {
  perfRuntimeOperationFacts,
  type PerfNativeCaptureLiveHandle,
  type PerfRuntimeOperations,
} from '@agent-device/contracts/perf-runtime';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceIdentity } from '@agent-device/kernel/device';
import { makeAndroidSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../../../__tests__/test-utils/runtime-operation-facts.ts';
import { createPerfCaptureAdmissionLedger } from '../../../perf-capture-admission-ledger.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../../request-runtime-binding.ts';
import { handleSessionObservabilityCommands } from '../../index.ts';

const available = Object.freeze({ available: true as const });
const unavailable = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});

test('perf requires an active session', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName: 'default',
    sessionStore,
  });

  assert.ok(response);
  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.equal(response.error.code, 'SESSION_NOT_FOUND');
  }
});

test('perf frames admits and binds only the selected runtime operation', async () => {
  const sessionStore = makeStore();
  const perfFrames = vi.fn(async (_input: Parameters<PerfRuntimeOperations['perfFrames']>[0]) => ({
    metric: { available: true, fps: 59.8 },
    sampling: { method: 'fixture' },
  }));
  const runtime = createPerfRuntime({ perfFrames });

  const response = await handleSessionObservabilityCommands({
    req: { token: 't', session: 'android', command: 'perf', positionals: ['frames'] },
    sessionName: 'android',
    sessionStore,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
    perfCaptureAdmissionLedger: createPerfCaptureAdmissionLedger(),
  });

  assert.equal(response?.ok, true, JSON.stringify(response));
  assert.deepEqual(runtime.uses, [['perfFrames']]);
  assert.equal(perfFrames.mock.calls[0]?.[0].appId, 'com.example.app');
  assert.deepEqual(response?.data?.metrics, { fps: { available: true, fps: 59.8 } });
});

test('perf refuses from owner facts before binding', async () => {
  const sessionStore = makeStore();
  const runtime = createPerfRuntime({}, unavailable);
  const response = await handleSessionObservabilityCommands({
    req: { token: 't', session: 'android', command: 'perf', positionals: ['memory', 'sample'] },
    sessionName: 'android',
    sessionStore,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
    perfCaptureAdmissionLedger: createPerfCaptureAdmissionLedger(),
  });

  assert.equal(response?.ok, false);
  assert.deepEqual(runtime.uses, []);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'UNSUPPORTED_OPERATION');
    assert.equal(response.error.details?.reason, 'owner-capability-missing');
  }
});

test('perf native capture is adopted durably and stop uses the live handle without rebinding', async () => {
  const sessionStore = makeStore();
  const device = sessionStore.get('android')!.device;
  const finish = vi.fn(async () => ({
    status: 'completed' as const,
    result: {
      kind: 'xctrace',
      mode: 'trace',
      state: 'stopped',
      outPath: '/tmp/app.trace',
    } as const,
  }));
  const handle: PerfNativeCaptureLiveHandle = {
    inspect: () => ({ kind: 'xctrace', mode: 'trace', state: 'running' }),
    setOutputPath: vi.fn(),
    finish,
    forceCleanup: async () => ({ status: 'cleaned' }),
    [Symbol.asyncDispose]: async () => {},
  };
  const perfNativeCaptureStart = vi.fn(
    async (input: Parameters<PerfRuntimeOperations['perfNativeCaptureStart']>[0]) => ({
      pendingHandle: new PendingTransferGuard(handle),
      envelope: createDurableResourceEnvelope({
        resourceKind: 'perf-capture',
        sessionId: input.sessionId,
        device: deviceIdentity(device),
        owner: localRuntimeOwner('android'),
        fence: input.fence,
        lifecycle: 'open',
        descriptor: { version: 1, body: { kind: 'fixture' } },
      }),
      response: {
        kind: 'xctrace',
        mode: 'trace',
        state: 'running',
        outPath: input.outPath,
      } as const,
    }),
  );
  const runtime = createPerfRuntime({ perfNativeCaptureStart });
  const common = {
    sessionName: 'android',
    sessionStore,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
    perfCaptureAdmissionLedger: createPerfCaptureAdmissionLedger(),
    throwIfCanceled: () => {},
  };

  const startResponse = await handleSessionObservabilityCommands({
    ...common,
    req: {
      token: 't',
      session: 'android',
      command: 'perf',
      positionals: ['trace', 'start', 'xctrace'],
      flags: { out: '/tmp/app.trace' },
    },
  });
  assert.equal(startResponse?.ok, true, JSON.stringify(startResponse));
  assert.ok(sessionStore.get('android')?.perfCapture);
  assert.deepEqual(
    sessionStore.get('android')?.actions.map(({ command }) => command),
    ['perf'],
  );

  const wrongModeResponse = await handleSessionObservabilityCommands({
    ...common,
    req: {
      token: 't',
      session: 'android',
      command: 'perf',
      positionals: ['cpu', 'profile', 'stop', 'xctrace'],
    },
  });
  assert.equal(wrongModeResponse?.ok, false);
  if (wrongModeResponse && !wrongModeResponse.ok) {
    assert.equal(
      wrongModeResponse.error.message,
      'No xctrace cpu-profile is active for this session.',
    );
  }
  assert.equal(finish.mock.calls.length, 0);
  assert.ok(sessionStore.get('android')?.perfCapture);
  assert.equal(sessionStore.get('android')?.actions.length, 1);

  const stopResponse = await handleSessionObservabilityCommands({
    ...common,
    req: {
      token: 't',
      session: 'android',
      command: 'perf',
      positionals: ['trace', 'stop', 'xctrace'],
    },
  });
  assert.equal(stopResponse?.ok, true, JSON.stringify(stopResponse));
  assert.equal(finish.mock.calls.length, 1);
  assert.deepEqual(runtime.uses, [['perfNativeCaptureStart']]);
  assert.equal(sessionStore.get('android')?.perfCapture, undefined);
  assert.deepEqual(
    sessionStore.get('android')?.actions.map(({ command }) => command),
    ['perf', 'perf'],
  );
});

function makeStore() {
  const sessionStore = makeSessionStore('agent-device-perf-runtime-');
  sessionStore.set('android', makeAndroidSession('android', { appBundleId: 'com.example.app' }));
  return sessionStore;
}

function createPerfRuntime(
  operations: Partial<PerfRuntimeOperations>,
  fact: RuntimeOperationFact = available,
) {
  const uses: string[][] = [];
  const factsFor = (device: DeviceInfo) => ({
    device: {
      family: device.platform,
      kind: device.kind,
      providerMode: 'local' as const,
    },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      appState: unavailable,
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: unavailable,
      bootTarget: unavailable,
      bootTargetHeadless: unavailable,
      listApps: unavailable,
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      ...applicationLifecycleOperationFacts({
        resolveOpenTarget: unavailable,
        prepareApplicationOpen: unavailable,
        openApplication: unavailable,
        applyRuntimeHints: unavailable,
        clearRuntimeHints: unavailable,
        closeApplication: unavailable,
        finalizeApplicationClose: unavailable,
        prepareAppleRunner: unavailable,
        configureProviderPortReverse: unavailable,
      }),
      ...perfRuntimeOperationFacts({
        frames: fact,
        memorySample: fact,
        memorySnapshot: fact,
        nativeCapture: fact,
        profileReport: fact,
      }),
    },
  });
  const inspectFacts: InspectDeviceRuntimeFacts = async (device) => factsFor(device);
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    uses.push([...use.required]);
    return narrowDeviceBinding(
      {
        device,
        owner: localRuntimeOwner(device.platform),
        facts: factsFor(device),
        operations,
        [Symbol.asyncDispose]: async () => {},
      } satisfies import('@agent-device/contracts/platform-runtime').DeviceBinding<PlatformRuntimeOperations>,
      use,
    );
  };
  return { inspectFacts, bindDevice, uses };
}
