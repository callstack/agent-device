import { beforeEach, expect, test, vi } from 'vitest';
import {
  sessionCloseShutdownFixture,
  type SessionState,
} from './session-close-shutdown.fixtures.ts';
import { installFakeManagedAgentBrowser } from '../../../__tests__/test-utils/web-managed-agent-browser.ts';

const {
  AppError,
  handleSessionCommands,
  makeIosSimulatorRecordingSession,
  makeSession,
  makeSessionStore,
  mockRunCmd,
  mockStopAndroidSnapshotHelperSessionForDevice,
  mockStopIosRunnerSession,
  mockStopIosRunnerSession: stopIosRunnerSession,
  noopInvoke,
  os,
  path,
  recordingCleanupMock,
  recordingFinishMock,
  resetSessionCloseShutdownMocks,
  screenRecordingResourceStore,
  teardownSessionResources,
  WEB_DESKTOP_DEVICE,
} = sessionCloseShutdownFixture;

beforeEach(resetSessionCloseShutdownMocks);

function agentBrowserJsonResult(value: unknown, exitCode = 0) {
  return { stdout: JSON.stringify(value), stderr: '', exitCode };
}

test('close finalizes an active iOS simulator recording before deleting the session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-active-recording-close-session';
  const session = makeIosSimulatorRecordingSession(sessionStore, sessionName);
  const finish = recordingFinishMock(session);
  sessionStore.set(sessionName, session);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  // The recorder was signaled (SIGINT finalizes the simctl mp4), the recording
  // was detached, and the session was deleted — no orphaned recordVideo child.
  expect(finish).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)).toBeUndefined();
  // An active recording at close time still defeats iOS runner retention even
  // though the recording is finalized (and cleared) before the retention step.
  expect(mockStopIosRunnerSession).toHaveBeenCalledWith(session.device.id);
  expect(finish.mock.invocationCallOrder[0]).toBeLessThan(
    mockStopIosRunnerSession.mock.invocationCallOrder[0]!,
  );
});

test('close surfaces a recording finalization failure through the cleanup-failure channel', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-recording-close-failure-session';
  const session = makeIosSimulatorRecordingSession(sessionStore, sessionName, {
    recorderExitCode: 1,
  });
  const finish = recordingFinishMock(session);
  const forceCleanup = recordingCleanupMock(session);
  sessionStore.set(sessionName, session);

  await expect(
    handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'close',
        positionals: [],
        flags: {},
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  ).rejects.toThrow(/recording: .*failed to stop recording/);

  // Cleanup failure is reported, later cleanup still ran, session still deleted.
  expect(finish).toHaveBeenCalledOnce();
  expect(forceCleanup).toHaveBeenCalledOnce();
  expect(mockStopIosRunnerSession).toHaveBeenCalledWith(session.device.id);
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('daemon resource teardown finalizes recording before lifecycle runner disposal', async () => {
  const sessionName = 'ios-active-recording-teardown-session';
  const sessionStore = makeSessionStore();
  const session = makeIosSimulatorRecordingSession(sessionStore, sessionName);
  const finish = recordingFinishMock(session);
  sessionStore.set(sessionName, session);

  await teardownSessionResources({
    appLog: 'already-settled',
    session,
    sessionName,
    sessionStore,
  });
  await teardownSessionResources({
    appLog: 'already-settled',
    session,
    sessionName,
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
  sessionStore.set(sessionName, session);

  await expect(
    teardownSessionResources({
      appLog: 'already-settled',
      session,
      sessionName,
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
  sessionStore.set(sessionName, session);

  await expect(
    teardownSessionResources({
      appLog: 'already-settled',
      session,
      sessionName,
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
  await teardownSessionResources({ appLog: 'already-settled', session, sessionName, sessionStore });

  expect(mockStopAndroidSnapshotHelperSessionForDevice).toHaveBeenCalledWith(session.device);
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
  sessionStore.set(sessionName, session);

  await expect(
    teardownSessionResources({
      appLog: 'already-settled',
      session,
      sessionName,
      sessionStore,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({
      reason: 'session_cleanup_incomplete',
      failedSteps: ['perf_capture'],
    }),
  });

  // The later resource still runs despite the earlier rejection.
  expect(mockStopAndroidSnapshotHelperSessionForDevice).toHaveBeenCalledWith(session.device);
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
  await installFakeManagedAgentBrowser(sessionStore.resolveDaemonStateDir());
  const session = makeSession(sessionName, WEB_DESKTOP_DEVICE);
  // Teardown always runs while the session it is tearing down is still in the store (session
  // deletion happens after), which is what keeps the provider-startup orphan sweep from treating
  // this session's own browser as an orphan and scanning real host processes for it.
  sessionStore.set(sessionName, session);
  mockRunCmd.mockResolvedValue(agentBrowserJsonResult({ success: true, data: {} }));

  await teardownSessionResources({ appLog: 'already-settled', session, sessionName, sessionStore });

  // A SIGTERM daemon shutdown (or an expired-session reap) tells agent-browser to close its
  // fleet right away, the same way an explicit `session close` does, instead of leaving the
  // Chrome processes to agent-browser's own multi-minute idle timer.
  expect(mockRunCmd).toHaveBeenCalledTimes(1);
  const [cmd, args] = mockRunCmd.mock.calls[0] as [string, string[]];
  // `node <entry> close ...`: the managed backend never runs through its `.bin` shim (#2022).
  expect(cmd).toBe(process.execPath);
  expect(args.slice(1)).toEqual(['close', '--json', '--session', sessionName]);
});

test('daemon session teardown surfaces a web close failure through the cleanup-failure channel', async () => {
  const sessionName = 'web-close-failure-teardown-session';
  const sessionStore = makeSessionStore();
  await installFakeManagedAgentBrowser(sessionStore.resolveDaemonStateDir());
  const session = makeSession(sessionName, WEB_DESKTOP_DEVICE);
  sessionStore.set(sessionName, session);
  mockRunCmd.mockResolvedValue(
    agentBrowserJsonResult({ success: false, error: 'no active browser session' }),
  );

  await expect(
    teardownSessionResources({ appLog: 'already-settled', session, sessionName, sessionStore }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({
      reason: 'session_cleanup_incomplete',
      failedSteps: ['web_browser'],
    }),
  });
});

test('daemon session teardown never dispatches a web close for a non-web session', async () => {
  const sessionName = 'android-non-web-teardown-session';
  const session = makeSession(sessionName, {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });

  await teardownSessionResources({
    appLog: 'already-settled',
    session,
    sessionName,
    sessionStore: makeSessionStore(),
  });

  expect(mockRunCmd).not.toHaveBeenCalled();
});
