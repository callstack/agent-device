import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { appLogResourceStore } from '@agent-device/capture-kit/app-log-durable-resource';
import { audioProbeDurableResource } from '@agent-device/capture-kit/audio-probe-session-resource';
import { encodeHostAudioProbeDescriptor } from '@agent-device/capture-kit/audio-probe-descriptor-fixtures';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { createAppLogStartResult, createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type { AudioProbeLiveHandle } from '@agent-device/contracts/audio-probe-runtime';
import type { AudioProbeResult } from '@agent-device/contracts/audio-probe-result';
import {
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  localRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { ScreenRecordingLiveHandle } from '@agent-device/contracts/screen-recording-runtime';
import { deviceIdentity } from '@agent-device/kernel/device';
import { type DaemonResponse, type DaemonResponseData } from '@agent-device/kernel/contracts';
import { type Mock, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { awaitFixtureReadiness } from '../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import {
  lifecycleDeviceRuntimeGateway,
  createRequestHandler,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { SessionStore } from '../../core/session-store.ts';
import { makeIosDevice } from './request-router-open-harness.ts';
import {
  createTestAppLogLiveHandle,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';

const DEVICE = { ...makeIosDevice('SIM-RECORD-ONLY'), appleOs: 'ios' as const };

vi.mock('../../core/device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
// The story's device, answered by both dispatch entry points: `record` resolves the device to record,
// and `open` resolves a selection for the device claim it takes.
vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const resolveTargetDevice = vi.fn(async () => DEVICE);
  return {
    ...actual,
    resolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(async () => ({
      device: await resolveTargetDevice(),
      reason: 'explicit-selector',
      source: 'local',
      candidateCount: 1,
      bootOccurred: false,
    })),
  };
});
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return { ...actual, readProcessStartTime: vi.fn(() => 'test-process-start') };
});
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return {
    ...actual,
    detachIosRunnerSessionsForShutdown: vi.fn(async () => {}),
    notifyIosRunnerAppRelaunched: vi.fn(async () => {}),
    prewarmIosRunner: vi.fn(async () => {}),
    prewarmIosRunnerSession: vi.fn(async () => {}),
    prepareIosRunner: vi.fn(async () => ({
      runner: { currentUptimeMs: 42 },
      connectMs: 0,
      healthCheckMs: 0,
    })),
    resolveRunnerAppBundleId: vi.fn(() => 'com.callstack.agentdevice.runner'),
    stopIosRunnerSession: vi.fn(async () => {}),
    stopAllIosRunnerSessions: vi.fn(async () => {}),
  };
});
vi.mock('@agent-device/platform-apple/app-lifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-lifecycle')>();
  return { ...actual, closeIosApp: vi.fn(async () => {}) };
});
vi.mock('@agent-device/platform-apple/app-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-resolution')>();
  return { ...actual, resolveIosApp: vi.fn(async (_device, app) => app) };
});

// SM-8: the record-only origin tells `record stop` that the recording may be the session's only
// owner, and retirement is a release precisely because nothing else is. `record start --scope device`
// creates such a session, and the session can then gain owners through paths the recording knows
// nothing about — `open`, `audio probe start`, or an app-event that publishes an app identity and
// lets `logs start` attach to it. Every story here runs through the router, so the resource is
// attached by the command that really attaches it and the stop is the request that really stops.
const SESSION = 'record-only-session';
const mockAwaitFixtureReadiness = vi.mocked(awaitFixtureReadiness);

function makeSessionStore(prefix: string): SessionStore {
  const root = mkdtempForTestSync(prefix);
  return new SessionStore(
    path.join(root, 'sessions'),
    createTestHostEnvironment({
      env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims') },
    }),
  );
}

beforeEach(() => {
  mockAwaitFixtureReadiness.mockReset();
  mockAwaitFixtureReadiness.mockResolvedValue(undefined);
});

test('record stop leaves a session an open took over intact, and close releases it', async () => {
  const sessionStore = makeSessionStore('agent-device-record-only-open-');
  const outPath = path.join(sessionStore.resolveDaemonStateDir(), 'record-only.mp4');
  const recording = createRecordingGateway(outPath);
  const handler = createHandler(sessionStore, recording.gateway);

  // The recording is the only owner of the session `record start` publishes.
  expect(await unwrap(handler(recordRequest(['start', outPath], 'req-start')))).toMatchObject({
    recording: 'started',
  });

  const ref = sessionStore.lookup(SESSION);
  if (!ref) throw new Error('expected `record start` to publish its session');
  expect(ref.session.recordOnlySession).toBe(true);

  // `open` publishes an app into the same session, so the recording stops being its only owner. The
  // origin stays on the record — retirement is decided from what the session owns, not from a marker
  // every attaching path has to remember to clear.
  await unwrap(handler(request('open', ['com.example.app'], 'req-open')));
  expect(sessionStore.requireCurrent(ref).recordOnlySession).toBe(true);

  // The session now holds an app-log stream beside the recording, attached by the command that
  // really attaches one. Retirement would drop the record out from under a live stream.
  await unwrap(handler(request('logs', ['start'], 'req-logs-start')));
  expect(sessionStore.requireCurrent(ref).appLog).toBeDefined();

  const stopped = await unwrap(handler(recordRequest(['stop'], 'req-promoted-stop')));

  // The stop's own answer stays a start-time fact: this recording did begin a record-only session.
  expect(stopped).toMatchObject({ recording: 'stopped', recordOnlySession: true });
  expect(recording.finish).toHaveBeenCalledOnce();
  expect(sessionStore.get(SESSION)).toBeDefined();
  expect(sessionStore.requireCurrent(ref).screenRecording).toBeUndefined();

  // Only the close that owns the session's teardown releases the claim and the app log with it.
  await unwrap(handler(request('close', [], 'req-close')));
  expect(sessionStore.get(SESSION)).toBeUndefined();
  expect(appLogResourceStore.read(appLogResourcePath(sessionStore))).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
});

test('record stop leaves a session an audio probe attached intact, and the probe stop releases it', async () => {
  const sessionStore = makeSessionStore('agent-device-record-only-audio-');
  const outPath = path.join(sessionStore.resolveDaemonStateDir(), 'record-only.mp4');
  const recording = createRecordingGateway(outPath);
  const handler = createHandler(sessionStore, recording.gateway);

  await unwrap(handler(recordRequest(['start', outPath], 'req-audio-start')));
  const ref = sessionStore.lookup(SESSION);
  if (!ref) throw new Error('expected `record start` to publish its session');

  // The audio sampler is adopted by its own command, on the session the recording created.
  await unwrap(handler(request('audio', ['probe', 'start', '120000', '1000'], 'req-audio-attach')));
  expect(sessionStore.requireCurrent(ref).audioProbe).toBeDefined();
  expect(sessionStore.requireCurrent(ref).recordOnlySession).toBe(true);

  const stopped = await unwrap(handler(recordRequest(['stop'], 'req-audio-stop')));

  expect(stopped).toMatchObject({ recording: 'stopped', recordOnlySession: true });
  expect(recording.finish).toHaveBeenCalledOnce();
  // The sampler is still running and its envelope is still open, so the session has to stay
  // addressable; retiring it would leave a helper nothing can stop or close.
  expect(sessionStore.get(SESSION)).toBeDefined();
  expect(sessionStore.requireCurrent(ref).audioProbe).toBeDefined();
  expect(audioProbeResourceStore.read(audioProbeResourcePath(sessionStore))).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });

  // The command that owns the probe still reaches the session and settles it.
  const probeStopped = await unwrap(
    handler(request('audio', ['probe', 'stop'], 'req-audio-stop-2')),
  );
  expect(probeStopped).toMatchObject({ state: 'stopped' });
  expect(sessionStore.requireCurrent(ref).audioProbe).toBeUndefined();
  expect(audioProbeResourceStore.read(audioProbeResourcePath(sessionStore))).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });

  await unwrap(handler(request('close', [], 'req-audio-close')));
  expect(sessionStore.get(SESSION)).toBeUndefined();
});

test('record stop leaves a session an app-event and its app log attached intact', async () => {
  const sessionStore = makeSessionStore('agent-device-record-only-app-event-');
  const outPath = path.join(sessionStore.resolveDaemonStateDir(), 'record-only.mp4');
  const recording = createRecordingGateway(outPath);
  // The app-event route answers the app identity through the platform-services port; this suite
  // pins what the daemon does with it, not the open-target rule itself.
  const handler = createHandler(sessionStore, recording.gateway, {
    resolveSessionAppBundleIdForTarget: async () => 'com.example.app',
  });

  await unwrap(handler(recordRequest(['start', outPath], 'req-event-start')));
  const ref = sessionStore.lookup(SESSION);
  if (!ref) throw new Error('expected `record start` to publish its session');

  // No `open` runs on this route: the deep link answers which app the session is now about, and
  // that identity is what makes `logs start` admissible.
  await unwrap(handler(request('trigger-app-event', ['checkout-ready'], 'req-event-attach')));
  expect(sessionStore.requireCurrent(ref).appBundleId).toBe('com.example.app');

  await unwrap(handler(request('logs', ['start'], 'req-event-logs-start')));
  expect(sessionStore.requireCurrent(ref).appLog).toBeDefined();

  const stopped = await unwrap(handler(recordRequest(['stop'], 'req-event-stop')));

  expect(stopped).toMatchObject({ recording: 'stopped', recordOnlySession: true });
  expect(recording.finish).toHaveBeenCalledOnce();
  expect(sessionStore.get(SESSION)).toBeDefined();
  expect(sessionStore.requireCurrent(ref).appLog).toBeDefined();
  expect(appLogResourceStore.read(appLogResourcePath(sessionStore))).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });

  // The stream the user started is still theirs to stop, and its durable record settles with it.
  await unwrap(handler(request('logs', ['stop'], 'req-event-logs-stop')));
  expect(sessionStore.requireCurrent(ref).appLog).toBeUndefined();
  expect(appLogResourceStore.read(appLogResourcePath(sessionStore))).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });

  await unwrap(handler(request('close', [], 'req-event-close')));
  expect(sessionStore.get(SESSION)).toBeUndefined();
});

test('record stop still retires a session that stayed record-only', async () => {
  const sessionStore = makeSessionStore('agent-device-record-only-retire-');
  const outPath = path.join(sessionStore.resolveDaemonStateDir(), 'record-only.mp4');
  const recording = createRecordingGateway(outPath);
  const handler = createHandler(sessionStore, recording.gateway);

  await unwrap(handler(recordRequest(['start', outPath], 'req-retired-start')));
  const stopped = await unwrap(handler(recordRequest(['stop'], 'req-retired-stop')));

  // Nothing else ever joined this record, so its stop is its teardown: no session is left to close.
  expect(stopped).toMatchObject({ recording: 'stopped', recordOnlySession: true });
  expect(recording.finish).toHaveBeenCalledOnce();
  expect(sessionStore.get(SESSION)).toBeUndefined();
  // The recording's own durable record is terminal, which is what lets a later stop replay it.
  expect(
    screenRecordingResourceStore.read(
      screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(SESSION)),
    ),
  ).toMatchObject({ status: 'decoded', envelope: { lifecycle: 'completed' } });
});

/** Unwraps a daemon response so a refused request reports its own message instead of `{ ok: false }`. */
async function unwrap(response: Promise<DaemonResponse>): Promise<DaemonResponseData> {
  const settled = await response;
  if (!settled.ok) {
    throw new Error(`${settled.error.code}: ${settled.error.message}`);
  }
  return settled.data ?? {};
}

function createHandler(
  sessionStore: ReturnType<typeof makeSessionStore>,
  deviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations>,
  platformServiceOverrides: Partial<ReturnType<typeof daemonPlatformServicesFixture>> = {},
) {
  return createRequestHandler({
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_CLAIMS_DIR: path.join(sessionStore.resolveDaemonStateDir(), 'claims'),
        // The app-event route needs a URL template to deliver; without one it refuses before
        // publishing any app identity.
        AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE: 'myapp://agent-device/event?name={event}',
      },
    }),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway,
    platformServices: daemonPlatformServicesFixture(platformServiceOverrides),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

/** Every request of the story names the same session, which is what makes it one session's story. */
function request(command: string, positionals: string[], requestId: string) {
  return {
    token: 'test-token',
    session: SESSION,
    command,
    positionals,
    flags: {},
    meta: { requestId, sessionExplicit: true },
  };
}

function recordRequest(positionals: string[], requestId: string) {
  // `record start` on a session the daemon does not hold yet is refused unless the request also
  // states a device selector, which is what gives the recording a device to start on.
  return {
    ...request('record', positionals, requestId),
    flags: { recordingScope: 'device' as const, platform: 'ios' as const },
  };
}

function appLogResourcePath(sessionStore: ReturnType<typeof makeSessionStore>) {
  return appLogResourceStore.resolvePath(sessionStore.resolveSessionDir(SESSION));
}

const audioProbeResourceStore = audioProbeDurableResource.store;

function audioProbeResourcePath(sessionStore: ReturnType<typeof makeSessionStore>) {
  return audioProbeResourceStore.resolvePath(sessionStore.resolveSessionDir(SESSION));
}

/**
 * The shared lifecycle gateway widened with the screen-recording, audio-probe and app-log
 * operations, so `record`, `open`, `audio`, `logs`, `trigger-app-event` and `close` all reach one
 * runtime over the same device.
 */
function createRecordingGateway(outPath: string): {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  finish: Mock<ScreenRecordingLiveHandle['finish']>;
} {
  const available = Object.freeze({ available: true as const });
  const withRecording = (
    facts: RuntimeFacts<PlatformRuntimeOperations>,
  ): RuntimeFacts<PlatformRuntimeOperations> => ({
    device: facts.device,
    operations: {
      ...facts.operations,
      screenRecordingStart: available,
      screenRecordingReattach: available,
      screenRecordingCleanup: available,
      audioProbeStart: available,
      audioProbeReattach: available,
      audioProbeCleanup: available,
      audioProbeQuery: available,
      appLogInspect: available,
      appLogDoctor: available,
      appLogStart: available,
      appLogReattach: available,
      appLogCleanup: available,
      triggerAppEvent: available,
    },
  });
  const finish = vi.fn<ScreenRecordingLiveHandle['finish']>(async () => {
    fs.writeFileSync(outPath, 'recorded video');
    return {
      status: 'completed' as const,
      result: {
        backend: 'simctl recordVideo',
        outPath,
        startedAt: 1,
        completedAt: 2,
        scope: 'device' as const,
        showTouches: false,
        recordOnlySession: true,
      },
    };
  });
  const appLogFinish = vi.fn(async () => ({
    status: 'completed' as const,
    result: {
      backend: 'ios-simulator' as const,
      outputPath: '/tmp/app.log',
      completedAt: 2,
    },
  }));
  const captureOperations = {
    screenRecordingStart: async (
      input: Parameters<PlatformRuntimeOperations['screenRecordingStart']>[0],
    ) => ({
      pendingHandle: new PendingTransferGuard(createRecordingHandle(finish, outPath)),
      // Admission compares the envelope's authority with the binding's device, owner and fence, so
      // the fake has to state them exactly.
      envelope: createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: input.sessionId,
        device: deviceIdentity(DEVICE),
        owner: localRuntimeOwner(DEVICE.platform),
        fence: input.fence,
        lifecycle: 'open',
        descriptor: { version: 1, body: { recordingId: SESSION } },
      }),
    }),
    screenRecordingReattach: async () => ({ status: 'missing' }) as const,
    screenRecordingCleanup: async () => ({ status: 'already-missing' }) as const,
    audioProbeStart: async (
      input: Parameters<PlatformRuntimeOperations['audioProbeStart']>[0],
    ) => ({
      pendingHandle: new PendingTransferGuard(createAudioProbeHandle()),
      envelope: createDurableResourceEnvelope({
        resourceKind: 'audio-probe',
        sessionId: input.sessionId,
        device: deviceIdentity(DEVICE),
        owner: localRuntimeOwner(DEVICE.platform),
        fence: input.fence,
        lifecycle: 'open',
        descriptor: encodeHostAudioProbeDescriptor({
          backend: 'macos-screencapturekit',
          source: 'system-audio',
          sourceCount: 1,
          notes: [],
          statusPath: input.statusPath,
          startedAt: 1,
          durationMs: input.durationMs,
          bucketMs: input.bucketMs,
          marker: { pid: 4242, startTime: 'boot+1', command: 'helper' },
        }),
      }),
    }),
    audioProbeReattach: async () => ({ status: 'missing' }) as const,
    audioProbeCleanup: async () => ({ status: 'cleaned' }) as const,
    appLogInspect: async () => ({ backend: 'ios-simulator' as const }),
    appLogDoctor: async () => ({
      backend: 'ios-simulator' as const,
      checks: { simulatorLogStream: true },
      notes: [],
    }),
    appLogStart: async (input: Parameters<PlatformRuntimeOperations['appLogStart']>[0]) =>
      createAppLogStartResult(
        createTestAppLogLiveHandle({
          inspect: () => ({ backend: 'ios-simulator', state: 'active', startedAt: 1 }),
          finish: appLogFinish,
          forceCleanup: async () => ({ status: 'cleaned' }),
        }),
        createDurableResourceEnvelope({
          resourceKind: 'app-log',
          sessionId: input.sessionId,
          device: deviceIdentity(DEVICE),
          owner: localRuntimeOwner(DEVICE.platform),
          fence: input.fence,
          lifecycle: 'open',
          descriptor: { version: 1, body: { outputPath: input.outputPath } },
        }),
      ),
    appLogReattach: async () => ({ status: 'missing' }) as const,
    appLogCleanup: async () => ({ status: 'cleaned' }) as const,
    triggerAppEvent: async () => {},
  } satisfies Partial<PlatformRuntimeOperations>;
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: async (device) =>
      withRecording(await lifecycleDeviceRuntimeGateway.inspectFacts(device)),
    bind: async (bindingRequest) => {
      const widened: DeviceBinding<PlatformRuntimeOperations> =
        await lifecycleDeviceRuntimeGateway.bind(bindingRequest);
      return {
        ...widened,
        facts: withRecording(widened.facts),
        operations: { ...widened.operations, ...captureOperations },
      };
    },
    shutdown: async () => {},
  };
  return { gateway, finish };
}

function createAudioProbeHandle(): AudioProbeLiveHandle {
  let stopped = false;
  const status = (state: 'running' | 'stopped'): AudioProbeResult => ({
    audio: 'probe',
    state,
    active: state === 'running',
    heard: state === 'running',
    source: 'system-audio',
    backend: 'macos-screencapturekit',
    durationMs: 120_000,
    elapsedMs: 0,
    bucketMs: 1_000,
    sampleCount: 0,
    sourceCount: 1,
    rmsDbfs: [],
    peakDbfs: [],
  });
  return Object.freeze({
    inspect: () => ({
      source: 'system-audio' as const,
      backend: 'macos-screencapturekit',
      sourceCount: 1,
      notes: [],
      statusPath: '/tmp/audio-probe.json',
      startedAt: 1,
      durationMs: 120_000,
      bucketMs: 1_000,
    }),
    status: async () => status(stopped ? 'stopped' : 'running'),
    finish: async () => {
      stopped = true;
      return { status: 'completed' as const, result: status('stopped') };
    },
    forceCleanup: async () => ({ status: 'cleaned' }) as const,
    [Symbol.asyncDispose]: async () => {},
  });
}

function createRecordingHandle(
  finish: Mock<ScreenRecordingLiveHandle['finish']>,
  outPath: string,
): ScreenRecordingLiveHandle {
  return {
    inspect: () => ({
      backend: 'simctl recordVideo',
      outPath,
      startedAt: 1,
      scope: 'device',
      showTouches: false,
      recordOnlySession: true,
      gestureEvents: [],
    }),
    appendGestureEvents: () => {},
    setTouchReferenceFrame: () => {},
    setRunnerSessionId: () => {},
    invalidate: () => {},
    finish,
    forceCleanup: async () => ({ status: 'cleaned' }),
    [Symbol.asyncDispose]: async () => {},
  };
}
