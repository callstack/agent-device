import { beforeEach, expect, test, vi } from 'vitest';
import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity } from '@agent-device/kernel/device';
import {
  sessionCloseShutdownFixture,
  type SessionState,
} from '../session-lifecycle/internal/__tests__/session-close-shutdown.fixtures.ts';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { lifecycleOperationsSpy } from '../../__tests__/support/lifecycle-operations-spy.ts';

const stopEvents = vi.hoisted(() => ({ order: [] as string[], failing: new Set<string>() }));

function recordStop(step: string): void {
  stopEvents.order.push(step);
  if (stopEvents.failing.has(step)) throw new Error(`${step} stop failed`);
}

vi.mock('@agent-device/capture-kit/screen-recording-session-resource', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@agent-device/capture-kit/screen-recording-session-resource')
  >()),
  finishLiveScreenRecording: vi.fn(async () => recordStop('recording')),
}));
vi.mock('@agent-device/capture-kit/audio-probe-session-resource', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@agent-device/capture-kit/audio-probe-session-resource')
  >()),
  finishLiveAudioProbe: vi.fn(async () => recordStop('audio_probe')),
}));
vi.mock('@agent-device/capture-kit/perf-capture-session-resource', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@agent-device/capture-kit/perf-capture-session-resource')
  >()),
  finishLivePerfCapture: vi.fn(async () => recordStop('perf_capture')),
}));
vi.mock('../../resources/app-log-session-resource.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../resources/app-log-session-resource.ts')>()),
  forceCleanupSessionAppLog: vi.fn(async () => recordStop('app_log')),
}));

bindTestCommandHost();

const {
  handleSessionCommands,
  makeIosSimulatorRecordingSession,
  makeSessionStore,
  mkdtempForTestSync,
  noopInvoke,
  path,
  resetSessionCloseShutdownMocks,
  teardownSessionResources,
} = sessionCloseShutdownFixture;

beforeEach(() => {
  resetSessionCloseShutdownMocks();
  stopEvents.order.length = 0;
  stopEvents.failing.clear();
});

function sessionWithEveryResource(
  sessionStore: ReturnType<typeof makeSessionStore>,
  name: string,
): SessionState {
  const session = makeIosSimulatorRecordingSession(sessionStore, name);
  const device = deviceIdentity(session.device);
  const unexpectedHandleUse = (): never => {
    throw new Error('Resource handles must be stopped through the mocked finisher seams');
  };
  const coordinates = {
    sessionId: name,
    device,
    owner: localRuntimeOwner(device.family),
    fence: { token: 'teardown-order', generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: {} },
  } as const;
  return {
    ...session,
    appLog: {
      handle: {
        inspect: unexpectedHandleUse,
        finish: unexpectedHandleUse,
        forceCleanup: unexpectedHandleUse,
        [Symbol.asyncDispose]: unexpectedHandleUse,
      },
      envelope: createDurableResourceEnvelope({ ...coordinates, resourceKind: 'app-log' }),
    },
    audioProbe: {
      handle: {
        inspect: unexpectedHandleUse,
        status: unexpectedHandleUse,
        finish: unexpectedHandleUse,
        forceCleanup: unexpectedHandleUse,
        [Symbol.asyncDispose]: unexpectedHandleUse,
      },
      envelope: createDurableResourceEnvelope({ ...coordinates, resourceKind: 'audio-probe' }),
    },
    perfCapture: {
      handle: {
        inspect: unexpectedHandleUse,
        setOutputPath: unexpectedHandleUse,
        finish: unexpectedHandleUse,
        forceCleanup: unexpectedHandleUse,
        [Symbol.asyncDispose]: unexpectedHandleUse,
      },
      envelope: createDurableResourceEnvelope({ ...coordinates, resourceKind: 'perf-capture' }),
    },
  };
}

function recordingPlatformCleanup() {
  return platformResourceCleanupFixture({
    stopSnapshotHelper: async () => recordStop('platform_snapshot_helper'),
  });
}

type Caller = {
  name: string;
  run(args: { sessionName: string }): Promise<unknown>;
};

// Both production callers stop the same resources; they differ in how they surface failures.
const CALLERS: readonly Caller[] = [
  {
    name: 'daemon teardown',
    run: ({ sessionName }) => {
      const sessionStore = makeSessionStore();
      sessionStore.publish(sessionName, sessionWithEveryResource(sessionStore, sessionName));
      return teardownSessionResources({
        appLog: 'run',
        ref: sessionStore.lookup(sessionName)!,
        sessionStore,
        platformCleanup: recordingPlatformCleanup(),
      });
    },
  },
  {
    name: 'ordinary close',
    run: ({ sessionName }) => {
      const sessionStore = makeSessionStore();
      sessionStore.publish(sessionName, sessionWithEveryResource(sessionStore, sessionName));
      return handleSessionCommands({
        host: createTestHostEnvironment(),
        createCommandSurface: fakeCreateCommandSurface,
        platformServices: daemonPlatformServicesFixture(),
        platformResourceCleanup: recordingPlatformCleanup(),
        lifecycleOperationsLoader: lifecycleOperationsSpy().loader,
        req: { token: 't', session: sessionName, command: 'close', positionals: [], flags: {} },
        sessionName,
        logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
        sessionStore,
        invoke: noopInvoke,
      });
    },
  },
];

const COMMON_RESOURCE_ORDER = [
  'recording',
  'app_log',
  'audio_probe',
  'perf_capture',
  'platform_snapshot_helper',
];

test.each(CALLERS)('$name stops session resources in the shared order', async ({ run }) => {
  await run({ sessionName: 'stop-order-session' });

  expect(stopEvents.order).toEqual(COMMON_RESOURCE_ORDER);
});

test.each(CALLERS)(
  '$name still stops the later resources after the recording stop fails',
  async ({ run }) => {
    stopEvents.failing.add('recording');

    await expect(run({ sessionName: 'stop-continuation-session' })).rejects.toMatchObject({
      details: expect.objectContaining({
        reason: 'session_cleanup_incomplete',
        failedSteps: ['recording'],
      }),
    });

    expect(stopEvents.order).toEqual(COMMON_RESOURCE_ORDER);
  },
);

test('daemon teardown omits the app-log stop once the app-log fence has settled', async () => {
  const sessionName = 'stop-already-settled-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, sessionWithEveryResource(sessionStore, sessionName));

  await teardownSessionResources({
    appLog: 'already-settled',
    ref: sessionStore.lookup(sessionName)!,
    sessionStore,
    platformCleanup: recordingPlatformCleanup(),
  });

  expect(stopEvents.order).toEqual([
    'recording',
    'audio_probe',
    'perf_capture',
    'platform_snapshot_helper',
  ]);
});
