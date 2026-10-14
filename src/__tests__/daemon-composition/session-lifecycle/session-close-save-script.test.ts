import { beforeEach, expect, test } from 'vitest';
import { composedPlatformServicesFixture } from '../platform-services-fixture.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { fakeCreateCommandSurface } from '../../../daemon/__tests__/support/command-surface-fake.ts';
import { composedLifecycleRuntimeFixture } from '../application-lifecycle-runtime-fixture.ts';
import { sessionCloseShutdownFixture } from '../../../daemon/session-lifecycle/internal/__tests__/session-close-shutdown.fixtures.ts';

const {
  handleSessionCommands: handleHarnessSessionCommands,
  fs,
  makeIosSimulatorRecordingSession,
  makeSessionStore,
  mockReleaseRunnerOnClose,
  mockStopIosRunnerSession,
  noopInvoke,
  path,
  recordingFinishMock,
  resetSessionCloseShutdownMocks,
} = sessionCloseShutdownFixture;

// The harness takes the lifecycle-operations loader per call, exactly like the gateway factories:
// these composition cases pass the REAL composed fixture instead of the daemon's canned default.
const handleSessionCommands = (params: Parameters<typeof handleHarnessSessionCommands>[0]) =>
  handleHarnessSessionCommands({
    ...params,
    lifecycleOperationsLoader: composedLifecycleRuntimeFixture,
  });

// The second half of this test proves that after the unarmed-authoring rejection, a plain close
// finalizes for real (recorder signaled, runner released with retain:false, session deleted) —
// the REAL Apple close finalization. The canned port fixture answers finalize without runner
// release, so the pair runs in the composition lane.
beforeEach(resetSessionCloseShutdownMocks);

test('close --save-script on a never-armed session is rejected before teardown, with no script written', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-unarmed-close-save-script-session';
  const scriptPath = path.join(
    mkdtempForTestSync('agent-device-unarmed-close'),
    `agent-device-unarmed-close-${Date.now()}.ad`,
  );
  // The fixture must carry real cleanup-bearing state (here: an active recording, like
  // `makeIosSimulatorRecordingSession`'s other consumers) so this test can actually prove the
  // guard runs *before* `stopBestEffortSessionResources` — not just that the response rejects.
  // Without it, moving the guard after teardown would still pass: there would be nothing for
  // teardown to observably touch.
  const session = makeIosSimulatorRecordingSession(sessionStore, sessionName);
  const finish = recordingFinishMock(session);
  sessionStore.publish(sessionName, session);

  await expect(
    handleSessionCommands({
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: composedPlatformServicesFixture(),
      req: {
        token: 't',
        session: sessionName,
        command: 'close',
        positionals: [],
        flags: { saveScript: scriptPath },
      },
      sessionName,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
  expect(mockReleaseRunnerOnClose).not.toHaveBeenCalled();

  // A plain close (no --save-script) still closes the same session cleanly afterward, and now
  // teardown genuinely does run: the recorder is signaled and the session deleted.
  const plainClose = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(plainClose?.ok).toBe(true);
  expect(finish).toHaveBeenCalledOnce();
  expect(mockReleaseRunnerOnClose).toHaveBeenCalledWith(session.device.id, { retain: false });
  expect(sessionStore.get(sessionName)).toBeUndefined();
});
