import { beforeEach, expect, test } from 'vitest';
import { sessionCloseShutdownFixture } from './session-close-shutdown.fixtures.ts';

const {
  fs,
  handleSessionCommands,
  makeIosSimulatorRecordingSession,
  makeSession,
  makeSessionStore,
  mockStopIosRunnerSession,
  noopInvoke,
  os,
  path,
  recordingFinishMock,
  resetSessionCloseShutdownMocks,
} = sessionCloseShutdownFixture;

beforeEach(resetSessionCloseShutdownMocks);

test('close --save-script on a never-armed session is rejected before teardown, with no script written', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-unarmed-close-save-script-session';
  const scriptPath = path.join(os.tmpdir(), `agent-device-unarmed-close-${Date.now()}.ad`);
  // The fixture must carry real cleanup-bearing state (here: an active recording, like
  // `makeIosSimulatorRecordingSession`'s other consumers) so this test can actually prove the
  // guard runs *before* `stopBestEffortSessionResources` — not just that the response rejects.
  // Without it, moving the guard after teardown would still pass: there would be nothing for
  // teardown to observably touch.
  const session = makeIosSimulatorRecordingSession(sessionStore, sessionName);
  const finish = recordingFinishMock(session);
  sessionStore.set(sessionName, session);

  await expect(
    handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'close',
        positionals: [],
        flags: { saveScript: scriptPath },
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: expect.stringMatching(/not armed/),
    details: expect.objectContaining({
      hint: expect.stringMatching(/open <app> --save-script/),
    }),
  });

  // The rejection does not tear down the session — it stays retryable/recoverable.
  expect(sessionStore.get(sessionName)).toBeDefined();
  expect(fs.existsSync(scriptPath)).toBe(false);
  // No teardown hook ran: the recording is still live (recorder never signaled) and the runner
  // was never told to stop. This is the assertion that goes red if the guard moves after
  // `stopBestEffortSessionResources` — see the counterfactual in the PR description.
  expect(finish).not.toHaveBeenCalled();
  expect(session.screenRecording).toBeDefined();
  expect(mockStopIosRunnerSession).not.toHaveBeenCalled();

  // A plain close (no --save-script) still closes the same session cleanly afterward, and now
  // teardown genuinely does run: the recorder is signaled and the session deleted.
  const plainClose = await handleSessionCommands({
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
  expect(plainClose?.ok).toBe(true);
  expect(finish).toHaveBeenCalledOnce();
  expect(mockStopIosRunnerSession).toHaveBeenCalledWith(session.device.id);
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close --save-script on a session with an active .ad repair transaction is unaffected by the unarmed-authoring guard', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-repair-close-save-script-session';
  const session = {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel_9_API_35',
      kind: 'emulator',
      booted: true,
    }),
    scriptPublication: {
      kind: 'repair' as const,
      status: 'complete' as const,
      target: { kind: 'default' as const, force: false },
      boundary: 0,
    },
  };
  sessionStore.set(sessionName, session);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { saveScript: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  // Repair transactions are a disjoint lifecycle (ADR 0012) with their own arming and close-time
  // commit protocol; the new unarmed-authoring guard must not intercept them.
  expect(response?.ok).toBe(true);
  expect(sessionStore.get(sessionName)).toBeUndefined();
});
