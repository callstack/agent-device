import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type {
  AudioProbeLiveHandle,
  AudioProbeStartInput,
} from '@agent-device/contracts/audio-probe-runtime';
import type { AudioProbeResult } from '@agent-device/contracts/audio-probe-result';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import {
  createDurableResourceEnvelope,
  encodeDurableDescriptor,
  hostAudioProbeDescriptorCodec,
} from '@agent-device/capture-kit';
import {
  IOS_DEVICE,
  WEB_DESKTOP_DEVICE,
} from '../../../../__tests__/test-utils/device-fixtures.ts';
import {
  makeAndroidSession,
  makeIosSession,
  makeMacOsSession,
  makeSession,
} from '../../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import {
  unavailableApplicationLifecycleOperationFacts,
  unavailableDeploymentSnapshotAndShutdownOperationFacts,
} from '../../../../__tests__/test-utils/runtime-operation-facts.ts';
import { createAudioProbeAdmissionLedger } from '../../../audio-probe-admission-ledger.ts';
import { audioProbeDurableResource } from '../../../audio-probe-session-resource.ts';
import type { SessionStore } from '../../../session-store.ts';
import type { DaemonResponse } from '../../../types.ts';
import { handleSessionObservabilityCommands } from '../../index.ts';
import { ANDROID_AUDIO_CONTRACT_EVIDENCE } from '../../__tests__/session-audio.coverage.ts';

async function runAudio(
  params: Parameters<typeof handleSessionObservabilityCommands>[0],
): Promise<DaemonResponse> {
  const response = await handleSessionObservabilityCommands(params);
  assert.ok(response);
  return response;
}

function ownerFor(device: DeviceInfo) {
  return localRuntimeOwner(device.platform as Parameters<typeof localRuntimeOwner>[0]);
}
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'audio is supported for web browser sessions, macOS sessions, iOS simulators, and Android emulators on macOS hosts',
} as const);

function factsFor(device: DeviceInfo, cells: { capture: boolean; query: boolean }) {
  return {
    device: {
      family: device.platform,
      kind: device.kind,
      providerMode: 'local' as const,
    },
    operations: {
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      ...unavailableApplicationLifecycleOperationFacts,
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      listApps: unavailable,
      appState: unavailable,
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: unavailable,
      bootTarget: unavailable,
      bootTargetHeadless: unavailable,
      audioProbeStart: cells.capture ? { available: true as const } : unavailable,
      audioProbeReattach: cells.capture ? { available: true as const } : unavailable,
      audioProbeCleanup: cells.capture ? { available: true as const } : unavailable,
      audioProbeQuery: cells.query ? { available: true as const } : unavailable,
    },
  };
}

function runningStatus(overrides: Partial<AudioProbeResult> = {}): AudioProbeResult {
  return {
    audio: 'probe',
    state: 'running',
    active: true,
    heard: true,
    source: 'system-audio',
    backend: 'macos-screencapturekit',
    durationMs: 1000,
    elapsedMs: 500,
    bucketMs: 500,
    sampleCount: 1,
    sourceCount: 1,
    rmsDbfs: [-18],
    peakDbfs: [-12],
    ...overrides,
  };
}

function fakeCaptureRuntime(device: DeviceInfo, status: AudioProbeResult) {
  const owner = ownerFor(device);
  const startCalls: AudioProbeStartInput[] = [];
  let finished = false;
  const handle: AudioProbeLiveHandle = Object.freeze({
    inspect: () => ({
      source: 'system-audio' as const,
      backend: 'macos-screencapturekit',
      sourceCount: 1,
      notes: [],
      statusPath: startCalls[0]?.statusPath ?? '',
      startedAt: Date.now(),
      durationMs: status.durationMs,
      bucketMs: status.bucketMs,
    }),
    status: async () =>
      finished ? { ...status, state: 'stopped' as const, active: false } : status,
    finish: async () => {
      finished = true;
      return {
        status: 'completed' as const,
        result: { ...status, state: 'stopped' as const, active: false, reason: 'stopped' },
      };
    },
    forceCleanup: async () => ({ status: 'cleaned' }) as const,
    [Symbol.asyncDispose]: async () => {},
  });
  const operations = {
    audioProbeStart: vi.fn(async (input: AudioProbeStartInput) => {
      startCalls.push(input);
      return {
        pendingHandle: new PendingTransferGuard(handle),
        envelope: createDurableResourceEnvelope({
          resourceKind: 'audio-probe',
          sessionId: input.sessionId,
          device: deviceIdentity(device),
          owner,
          fence: input.fence,
          lifecycle: 'open',
          descriptor: encodeDurableDescriptor(hostAudioProbeDescriptorCodec, {
            backend: 'macos-screencapturekit',
            source: 'system-audio',
            sourceCount: 1,
            notes: [],
            statusPath: input.statusPath,
            startedAt: Date.now(),
            durationMs: input.durationMs,
            bucketMs: input.bucketMs,
            marker: { pid: 4242, startTime: 'boot+1', command: 'helper' },
          }),
        }),
      };
    }),
  };
  return { operations, startCalls, handle };
}

function audioParams(
  sessionName: string,
  sessionStore: SessionStore,
  device: DeviceInfo,
  options: {
    positionals: string[];
    cells: { capture: boolean; query: boolean };
    operations?: Record<string, unknown>;
  },
) {
  const facts = factsFor(device, options.cells);
  const bindDevice = vi.fn(async () => ({
    device,
    owner: ownerFor(device),
    facts,
    operations: options.operations ?? {},
    [Symbol.asyncDispose]: async () => {},
  }));
  return {
    params: {
      req: {
        token: 't',
        session: sessionName,
        command: 'audio',
        positionals: options.positionals,
        flags: {},
      },
      sessionName,
      sessionStore,
      inspectFacts: vi.fn(async () => facts),
      bindDevice,
      audioProbeAdmissionLedger: createAudioProbeAdmissionLedger(),
      throwIfCanceled: () => {},
    },
    bindDevice,
  };
}

test('audio probe validates daemon duration bounds', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  sessionStore.set('web', makeSession('web', { device: WEB_DESKTOP_DEVICE }));
  const { params, bindDevice } = audioParams('web', sessionStore, WEB_DESKTOP_DEVICE, {
    positionals: ['probe', 'start', '99', '1000'],
    cells: { capture: false, query: true },
  });

  assertInvalidArgs(
    await runAudio(params as never),
    /duration must be an integer in range 100..120000/,
  );
  assert.equal(bindDevice.mock.calls.length, 0);
});

test('audio probe validates daemon bucket bounds', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  sessionStore.set('web', makeSession('web', { device: WEB_DESKTOP_DEVICE }));
  const { params, bindDevice } = audioParams('web', sessionStore, WEB_DESKTOP_DEVICE, {
    positionals: ['probe', 'start', '1000', '99'],
    cells: { capture: false, query: true },
  });

  assertInvalidArgs(
    await runAudio(params as never),
    /bucket must be an integer in range 100..10000/,
  );
  assert.equal(bindDevice.mock.calls.length, 0);
});

test('audio probe rejects timing positionals for status', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  sessionStore.set('web', makeSession('web', { device: WEB_DESKTOP_DEVICE }));
  const { params, bindDevice } = audioParams('web', sessionStore, WEB_DESKTOP_DEVICE, {
    positionals: ['probe', 'status', '1000'],
    cells: { capture: false, query: true },
  });

  assertInvalidArgs(await runAudio(params as never), /only supported with audio probe start/);
  assert.equal(bindDevice.mock.calls.length, 0);
});

test('audio refuses with the owner-stated hint when no fact admits it', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  sessionStore.set('ios-device', makeIosSession('ios-device', { device: IOS_DEVICE }));
  const { params, bindDevice } = audioParams('ios-device', sessionStore, IOS_DEVICE, {
    positionals: ['probe', 'status'],
    cells: { capture: false, query: false },
  });

  const response = await runAudio(params as never);
  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.equal(response.error.code, 'UNSUPPORTED_OPERATION');
    assert.match(response.error.message, /web browser sessions, macOS sessions, iOS simulators/);
  }
  assert.equal(bindDevice.mock.calls.length, 0);
});

test('audio probe start binds once, adopts the durable handle, and answers from it', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  const session = makeMacOsSession('macos');
  sessionStore.set('macos', session);
  const runtime = fakeCaptureRuntime(session.device, runningStatus());
  const { params, bindDevice } = audioParams('macos', sessionStore, session.device, {
    positionals: ['probe', 'start', '1000', '500'],
    cells: { capture: true, query: false },
    operations: runtime.operations,
  });

  const response = await runAudio(params as never);

  assert.ok(response.ok);
  assert.equal(bindDevice.mock.calls.length, 1);
  assert.equal(runtime.startCalls.length, 1);
  assert.equal(runtime.startCalls[0]?.durationMs, 1000);
  assert.equal(runtime.startCalls[0]?.bucketMs, 500);
  assert.match(runtime.startCalls[0]?.statusPath ?? '', /audio-probe\.json$/);
  assert.ok(sessionStore.get('macos')?.audioProbe);
  assert.equal(response.data?.backend, 'macos-screencapturekit');
  assert.deepEqual(response.data?.rmsDbfs, [-18]);
  const record = audioProbeDurableResource.store.read(
    audioProbeDurableResource.store.resolvePath(sessionStore.resolveSessionDir('macos')),
  );
  assert.equal(record.status, 'decoded');
  if (record.status === 'decoded') assert.equal(record.envelope.lifecycle, 'open');
});

test('audio probe starts host helper for iOS simulator audio', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  const session = makeIosSession('ios-sim');
  sessionStore.set('ios-sim', session);
  const runtime = fakeCaptureRuntime(session.device, runningStatus());
  const { params } = audioParams('ios-sim', sessionStore, session.device, {
    positionals: ['probe', 'start', '1000', '500'],
    cells: { capture: true, query: false },
    operations: runtime.operations,
  });

  const response = await runAudio(params as never);

  assert.ok(response.ok);
  assert.equal(runtime.startCalls.length, 1);
  assert.ok(sessionStore.get('ios-sim')?.audioProbe);
});

test(ANDROID_AUDIO_CONTRACT_EVIDENCE.testName, async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  const session = makeAndroidSession('android');
  sessionStore.set('android', session);
  const runtime = fakeCaptureRuntime(session.device, runningStatus({ peakDbfs: [-13] }));
  const { params } = audioParams('android', sessionStore, session.device, {
    positionals: ['probe', 'start', '1000', '500'],
    cells: { capture: true, query: false },
    operations: runtime.operations,
  });

  const response = await runAudio(params as never);

  assert.ok(response.ok);
  assert.deepEqual(response.data?.peakDbfs, [-13]);
  assert.ok(sessionStore.get('android')?.audioProbe);
});

test('audio probe stop finishes the durable resource and clears the slot', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  const session = makeMacOsSession('macos');
  sessionStore.set('macos', session);
  const runtime = fakeCaptureRuntime(session.device, runningStatus());
  const start = audioParams('macos', sessionStore, session.device, {
    positionals: ['probe', 'start', '1000', '500'],
    cells: { capture: true, query: false },
    operations: runtime.operations,
  });
  assert.ok((await runAudio(start.params as never)).ok);

  const stop = audioParams('macos', sessionStore, session.device, {
    positionals: ['probe', 'stop'],
    cells: { capture: true, query: false },
    operations: runtime.operations,
  });
  const response = await runAudio(stop.params as never);

  assert.ok(response.ok);
  assert.equal(response.data?.state, 'stopped');
  assert.equal(response.data?.active, false);
  assert.equal(sessionStore.get('macos')?.audioProbe, undefined);
  const record = audioProbeDurableResource.store.read(
    audioProbeDurableResource.store.resolvePath(sessionStore.resolveSessionDir('macos')),
  );
  assert.equal(record.status, 'decoded');
  if (record.status === 'decoded') assert.equal(record.envelope.lifecycle, 'completed');
});

test('audio probe status without an active probe reports not-started', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  const session = makeMacOsSession('macos');
  sessionStore.set('macos', session);
  const { params } = audioParams('macos', sessionStore, session.device, {
    positionals: ['probe', 'status'],
    cells: { capture: true, query: false },
  });

  const response = await runAudio(params as never);

  assert.ok(response.ok);
  assert.equal(response.data?.state, 'stopped');
  assert.equal(response.data?.reason, 'not-started');
});

test('audio probe forwards daemon millisecond timing to the web query operation', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  sessionStore.set('web', makeSession('web', { device: WEB_DESKTOP_DEVICE }));
  const audioProbeQuery = vi.fn(
    async (_input: { action: string; durationMs: number; bucketMs: number }) =>
      runningStatus({ source: 'media-elements', backend: 'agent-browser' }),
  );
  const { params, bindDevice } = audioParams('web', sessionStore, WEB_DESKTOP_DEVICE, {
    positionals: ['probe', 'start', '7500', '500'],
    cells: { capture: false, query: true },
    operations: { audioProbeQuery },
  });

  const response = await runAudio(params as never);

  assert.ok(response.ok);
  assert.equal(bindDevice.mock.calls.length, 1);
  assert.deepEqual(audioProbeQuery.mock.calls[0]?.[0], {
    action: 'start',
    durationMs: 7500,
    bucketMs: 500,
  });
});

function assertInvalidArgs(response: DaemonResponse | null, message: RegExp): void {
  assert.equal(response?.ok, false);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'INVALID_ARGS');
    assert.match(response.error.message, message);
  }
}
