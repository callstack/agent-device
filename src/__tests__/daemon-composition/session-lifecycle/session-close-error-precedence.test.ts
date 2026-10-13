import { beforeEach, expect, test } from 'vitest';
import { composedPlatformServicesFixture } from '../platform-services-fixture.ts';
import {
  sessionCloseShutdownFixture,
  type SessionState,
} from '@agent-device/daemon/testing/session-lifecycle/internal/__tests__/session-close-shutdown.fixtures';
import { fakeCreateCommandSurface } from '@agent-device/daemon/testing/__tests__/support/command-surface-fake';
import { composedLifecycleRuntimeFixture } from '../application-lifecycle-runtime-fixture.ts';

const {
  AppError,
  handleSessionCommands: handleHarnessSessionCommands,
  makeIosSimulatorRecordingSession,
  makeSession,
  makeSessionStore,
  mkdtempForTestSync,
  mockDispatchCommand,
  mockReleaseRunnerOnClose,
  mockStopIosRunnerSession,
  noopInvoke,
  path,
  resetSessionCloseShutdownMocks,
} = sessionCloseShutdownFixture;

// The harness takes the lifecycle-operations loader per call, exactly like the gateway factories:
// these composition cases pass the REAL composed fixture instead of the daemon's canned default.
const handleSessionCommands = (params: Parameters<typeof handleHarnessSessionCommands>[0]) =>
  handleHarnessSessionCommands({
    ...params,
    lifecycleOperationsLoader: composedLifecycleRuntimeFixture,
  });

// These two cases pin the REAL Apple close sequencing around a platform close: the runner stop
// that precedes dispatch on a physical device, and error precedence when the close effect itself
// fails. The canned port fixture answers close without runner staging, so they run in the
// composition lane.
beforeEach(resetSessionCloseShutdownMocks);

test('targeted close preserves the platform-close AppError and still runs later cleanup', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'targeted-close-error-session';
  const session = makeIosSimulatorRecordingSession(sessionStore, sessionName, {
    device: {
      platform: 'apple',
      id: 'sim-udid-close-error',
      name: 'iPhone 15',
      kind: 'simulator',
      booted: true,
    },
  });
  sessionStore.publish(sessionName, session);

  const platformCloseError = new AppError('DEVICE_UNAVAILABLE', 'platform close failed', {
    reason: 'device_disconnected',
    hint: 'Reconnect the device and retry close.',
  });
  mockDispatchCommand.mockRejectedValueOnce(platformCloseError);

  await expect(
    handleSessionCommands({
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: composedPlatformServicesFixture(),
      req: {
        token: 't',
        session: sessionName,
        command: 'close',
        positionals: ['com.example.app'],
        flags: {},
      },
      sessionName,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  ).rejects.toBe(platformCloseError);

  // The original AppError code/details/hint are preserved, not collapsed into a
  // generic cleanup aggregate.
  expect(platformCloseError.code).toBe('DEVICE_UNAVAILABLE');
  expect(platformCloseError.details).toMatchObject({
    reason: 'device_disconnected',
    hint: 'Reconnect the device and retry close.',
  });
  // A failed close is not recorded as `Closed`.
  expect(session.actions.some((action) => action.command === 'close')).toBe(false);
  // Subsequent independent cleanup still ran, and the session was still deleted.
  expect(mockReleaseRunnerOnClose).toHaveBeenCalledWith(session.device.id, { retain: false });
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('targeted close skips platform dispatch and preserves the error when the required pre-close runner stop fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'targeted-close-preclose-failure-session';
  // A physical Apple target (non-simulator) must stop its runner before the
  // platform close is dispatched — the runner owns the device connection.
  const session = {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'physical-device-close',
      name: 'My iPhone',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.app',
  } as unknown as SessionState;
  sessionStore.publish(sessionName, session);

  const preCloseError = new AppError('RUNNER_UNAVAILABLE', 'runner stop failed', {
    reason: 'runner_stop_failed',
    hint: 'Retry once the runner is reachable.',
  });
  // Scoped to this test's pre-close stop: this one-shot rejection is consumed there,
  // so it cannot leak into later tests when `vi.clearAllMocks()` clears only call
  // history — a persistent `mockRejectedValue` would leak into every later test that
  // exercises an Apple-platform runner stop.
  mockStopIosRunnerSession.mockRejectedValueOnce(preCloseError);

  await expect(
    handleSessionCommands({
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: composedPlatformServicesFixture(),
      req: {
        token: 't',
        session: sessionName,
        command: 'close',
        positionals: ['com.example.app'],
        flags: {},
      },
      sessionName,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  ).rejects.toBe(preCloseError);

  // The platform close must not be dispatched after a required pre-close stop fails.
  expect(mockDispatchCommand).not.toHaveBeenCalled();
  // The original failure code/details/hint are preserved, not collapsed into a
  // generic cleanup aggregate.
  expect(preCloseError.code).toBe('RUNNER_UNAVAILABLE');
  expect(preCloseError.details).toMatchObject({
    reason: 'runner_stop_failed',
    hint: 'Retry once the runner is reachable.',
  });
  // A skipped close is not recorded as `Closed`.
  expect(session.actions.some((action) => action.command === 'close')).toBe(false);
  // Later independent cleanup still ran (runner release re-attempted), and the
  // session was still deleted.
  expect(mockStopIosRunnerSession).toHaveBeenCalledOnce();
  expect(mockReleaseRunnerOnClose).toHaveBeenCalledWith(session.device.id, { retain: false });
  expect(sessionStore.get(sessionName)).toBeUndefined();
});
