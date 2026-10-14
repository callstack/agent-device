import { beforeEach, expect, test } from 'vitest';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import { composedPlatformServicesFixture } from '../platform-services-fixture.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { fakeCreateCommandSurface } from '@agent-device/daemon/testing/__tests__/support/command-surface-fake';
import { composedLifecycleRuntimeFixture } from '../application-lifecycle-runtime-fixture.ts';
import { sessionCloseShutdownFixture } from '@agent-device/daemon/testing/session-lifecycle/internal/__tests__/session-close-shutdown.fixtures';

const {
  handleSessionCommands: handleHarnessSessionCommands,
  makeIosSimulatorRecordingSession,
  makeSessionStore,
  mockReleaseRunnerOnClose,
  noopInvoke,
  path,
  recordingCleanupMock,
  recordingFinishMock,
  resetSessionCloseShutdownMocks,
} = sessionCloseShutdownFixture;

// The harness takes the lifecycle-operations loader per call, exactly like the gateway factories:
// these composition cases pass the REAL composed fixture instead of the daemon's canned default.
// The resource-cleanup capability is the production-composed one too: what defeats runner
// retention here is its real close policy reading `hasScreenRecording`, observed at the runner
// release below. The daemon-lane cleanup fixture answers retention with a canned false, which
// would let a policy that ignores the recording pass these cases.
const handleSessionCommands = (params: Parameters<typeof handleHarnessSessionCommands>[0]) =>
  handleHarnessSessionCommands({
    ...params,
    lifecycleOperationsLoader: composedLifecycleRuntimeFixture,
    platformResourceCleanup,
  });

// These cases pin the REAL Apple close finalization around an active recording: the recorder is
// signaled and cleaned before the runner release, and a finalization failure surfaces through the
// cleanup-failure channel without skipping later cleanup. The canned port fixture answers finalize
// without recording or runner staging, so they run in the composition lane.
beforeEach(resetSessionCloseShutdownMocks);

test('close finalizes an active iOS simulator recording before deleting the session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-active-recording-close-session';
  const session = makeIosSimulatorRecordingSession(sessionStore, sessionName);
  const finish = recordingFinishMock(session);
  sessionStore.publish(sessionName, session);

  const response = await handleSessionCommands({
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

  expect(response?.ok).toBe(true);
  // The recorder was signaled (SIGINT finalizes the simctl mp4), the recording
  // was detached, and the session was deleted — no orphaned recordVideo child.
  expect(finish).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)).toBeUndefined();
  // An active recording at close time still defeats iOS runner retention even
  // though the recording is finalized (and cleared) before the retention step.
  expect(mockReleaseRunnerOnClose).toHaveBeenCalledWith(session.device.id, { retain: false });
  expect(finish.mock.invocationCallOrder[0]).toBeLessThan(
    mockReleaseRunnerOnClose.mock.invocationCallOrder[0]!,
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
        flags: {},
      },
      sessionName,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  ).rejects.toThrow(/recording: .*failed to stop recording/);

  // Cleanup failure is reported, later cleanup still ran, session still deleted.
  expect(finish).toHaveBeenCalledOnce();
  expect(forceCleanup).toHaveBeenCalledOnce();
  expect(mockReleaseRunnerOnClose).toHaveBeenCalledWith(session.device.id, { retain: false });
  expect(sessionStore.get(sessionName)).toBeUndefined();
});
