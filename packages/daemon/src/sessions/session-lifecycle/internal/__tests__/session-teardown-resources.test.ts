import { beforeEach, expect, test, vi } from 'vitest';
import {
  sessionCloseShutdownFixture,
  type SessionState,
} from './session-close-shutdown.fixtures.ts';
import { platformResourceCleanupFixture } from '../../../../__tests__/support/platform-resource-cleanup-fixture.ts';

const {
  AppError,
  makeIosSimulatorRecordingSession,
  makeSession,
  makeSessionStore,
  mockStopIosRunnerSession,
  mockStopIosRunnerSession: stopIosRunnerSession,
  recordingCleanupMock,
  recordingFinishMock,
  resetSessionCloseShutdownMocks,
  screenRecordingResourceStore,
  teardownSessionResources,
  WEB_DESKTOP_DEVICE,
} = sessionCloseShutdownFixture;

beforeEach(resetSessionCloseShutdownMocks);

test('daemon resource teardown finalizes recording before lifecycle runner disposal', async () => {
  const sessionName = 'ios-active-recording-teardown-session';
  const sessionStore = makeSessionStore();
  const session = makeIosSimulatorRecordingSession(sessionStore, sessionName);
  const finish = recordingFinishMock(session);
  sessionStore.publish(sessionName, session);

  await teardownSessionResources({
    appLog: 'already-settled',
    ref: sessionStore.lookup(sessionName)!,
    sessionStore,
  });
  await teardownSessionResources({
    appLog: 'already-settled',
    ref: sessionStore.lookup(sessionName)!,
    sessionStore,
  });

  // Generic daemon teardown owns generic durable resources only. The admitted lifecycle unit
  // performs its independent forced disposal afterwards, so recording completion precedes the
  // runner stop without putting runner ownership back into the generic teardown list.
  await stopIosRunnerSession(session.device.id);

  expect(finish).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)?.screenRecording).toBeUndefined();
  expect(finish.mock.invocationCallOrder[0]).toBeLessThan(
    mockStopIosRunnerSession.mock.invocationCallOrder[0]!,
  );
});

test('daemon session teardown surfaces a recording finalization failure', async () => {
  const sessionName = 'ios-recording-teardown-failure-session';
  const sessionStore = makeSessionStore();
  const session = makeIosSimulatorRecordingSession(sessionStore, sessionName, {
    recorderExitCode: 1,
  });
  const finish = recordingFinishMock(session);
  const forceCleanup = recordingCleanupMock(session);
  sessionStore.publish(sessionName, session);

  await expect(
    teardownSessionResources({
      appLog: 'already-settled',
      ref: sessionStore.lookup(sessionName)!,
      sessionStore,
    }),
  ).rejects.toThrow(/recording: .*failed to stop recording/);

  expect(finish).toHaveBeenCalledOnce();
  expect(forceCleanup).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)?.screenRecording).toBeUndefined();
});

test('daemon session teardown retains recording evidence when finish and forced cleanup both fail', async () => {
  const sessionName = 'ios-recording-teardown-cleanup-failure-session';
  const sessionStore = makeSessionStore();
  const session = makeIosSimulatorRecordingSession(sessionStore, sessionName, {
    recorderExitCode: 1,
    cleanupConfirmed: false,
  });
  const finish = recordingFinishMock(session);
  const forceCleanup = recordingCleanupMock(session);
  sessionStore.publish(sessionName, session);

  await expect(
    teardownSessionResources({
      appLog: 'already-settled',
      ref: sessionStore.lookup(sessionName)!,
      sessionStore,
    }),
  ).rejects.toThrow(/recording: .*failed to stop recording/);

  expect(finish).toHaveBeenCalledOnce();
  expect(forceCleanup).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)?.screenRecording).toBeDefined();
  expect(
    screenRecordingResourceStore.read(
      screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName)),
    ),
  ).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'open',
      metadata: { phase: 'cleanup-pending', cleanupPendingReason: 'transport-failed' },
    },
  });
});

test('daemon session teardown stops Android snapshot helper session', async () => {
  const sessionName = 'android-snapshot-helper-teardown-session';
  const session = {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
  } as SessionState;

  const sessionStore = makeSessionStore();
  const ref = sessionStore.publish(sessionName, session);
  const platformCleanup = platformResourceCleanupFixture();
  await teardownSessionResources({
    appLog: 'already-settled',
    ref,
    sessionStore,
    platformCleanup,
  });

  expect(platformCleanup.stopSnapshotHelper).toHaveBeenCalledWith(session.device);
});

test('daemon session teardown attempts every resource after an earlier cleanup rejects', async () => {
  const sessionName = 'android-teardown-isolation-session';
  const session = {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
  } as SessionState;
  attachPerfCapture(
    session,
    vi.fn(async () => {
      throw new AppError('COMMAND_FAILED', 'perfetto stop failed');
    }),
  );

  // Perf cleanup runs before the snapshot-helper cleanup.
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, session);
  const platformCleanup = platformResourceCleanupFixture();

  await expect(
    teardownSessionResources({
      appLog: 'already-settled',
      ref: sessionStore.lookup(sessionName)!,
      sessionStore,
      platformCleanup,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({
      reason: 'session_cleanup_incomplete',
      failedSteps: ['perf_capture'],
    }),
  });

  // The later resource still runs despite the earlier rejection.
  expect(platformCleanup.stopSnapshotHelper).toHaveBeenCalledWith(session.device);
});

function attachPerfCapture(
  session: SessionState,
  finish = vi.fn(async () => ({
    status: 'completed' as const,
    result: { kind: 'xctrace', mode: 'cpu-profile', outPath: '/tmp/app.trace' } as const,
  })),
) {
  session.perfCapture = {
    handle: {
      inspect: () => ({ kind: 'xctrace', mode: 'cpu-profile', outPath: '/tmp/app.trace' }),
      setOutputPath: () => {},
      finish,
      forceCleanup: async () => ({ status: 'cleaned' }),
      [Symbol.asyncDispose]: async () => {},
    },
    envelope: {} as SessionState['perfCapture'] extends { envelope: infer Envelope }
      ? Envelope
      : never,
  };
  return finish;
}

test('daemon session teardown closes an open web session immediately, not on agent-browser idle timeout', async () => {
  const sessionName = 'web-active-session-teardown-session';
  const sessionStore = makeSessionStore();
  const session = makeSession(sessionName, WEB_DESKTOP_DEVICE);
  // Teardown always runs while the session it is tearing down is still in the store (session
  // deletion happens after), which is what keeps the provider-startup orphan sweep from treating
  // this session's own browser as an orphan and scanning real host processes for it.
  sessionStore.publish(sessionName, session);
  const platformCleanup = platformResourceCleanupFixture();

  await teardownSessionResources({
    appLog: 'already-settled',
    ref: sessionStore.lookup(sessionName)!,
    sessionStore,
    platformCleanup,
  });

  // A SIGTERM daemon shutdown (or an expired-session reap) asks the platform to close the
  // session's browser right away, the same way an explicit `session close` does, instead of
  // leaving the Chrome processes to agent-browser's own multi-minute idle timer. That the close
  // reaches the agent-browser process is real mechanics, pinned root-owned in
  // src/platform-runtime-resource-cleanup.test.ts.
  expect(platformCleanup.closeManagedBrowser).toHaveBeenCalledWith({
    device: WEB_DESKTOP_DEVICE,
    sessionName,
    stateDir: sessionStore.resolveDaemonStateDir(),
    openSessionNames: expect.any(Function),
  });
});

test('daemon session teardown surfaces a web close failure through the cleanup-failure channel', async () => {
  const sessionName = 'web-close-failure-teardown-session';
  const sessionStore = makeSessionStore();
  const session = makeSession(sessionName, WEB_DESKTOP_DEVICE);
  sessionStore.publish(sessionName, session);
  const platformCleanup = platformResourceCleanupFixture({
    closeManagedBrowser: async () => {
      throw new AppError('COMMAND_FAILED', 'no active browser session');
    },
  });

  await expect(
    teardownSessionResources({
      appLog: 'already-settled',
      ref: sessionStore.lookup(sessionName)!,
      sessionStore,
      platformCleanup,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({
      reason: 'session_cleanup_incomplete',
      failedSteps: ['web_browser'],
    }),
  });
});
