import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { beforeEach, expect, test } from 'vitest';
import { sessionCloseShutdownFixture } from './session-close-shutdown.fixtures.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import { lifecycleOperationsSpy } from '../../../../__tests__/support/lifecycle-operations-spy.ts';

const {
  handleSessionCommands,
  fs,
  makeIosSimulatorRecordingSession,
  makeSession,
  makeSessionStore,
  noopInvoke,
  path,
  recordingFinishMock,
  resetSessionCloseShutdownMocks,
} = sessionCloseShutdownFixture;

beforeEach(resetSessionCloseShutdownMocks);

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
  sessionStore.publish(sessionName, session);

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { saveScript: true },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  // Repair transactions are a disjoint lifecycle (ADR 0012) with their own arming and close-time
  // commit protocol; the new unarmed-authoring guard must not intercept them.
  expect(response?.ok).toBe(true);
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close --save-script on a never-armed session is rejected before teardown, with no script written', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-unarmed-close-save-script-session';
  const scriptPath = path.join(
    mkdtempForTestSync('agent-device-unarmed-close'),
    `agent-device-unarmed-close-${Date.now()}.ad`,
  );
  // The session carries cleanup-bearing state (an active recording) so the assertions below can
  // tell a guard that runs before teardown from one that runs after it.
  const session = makeIosSimulatorRecordingSession(sessionStore, sessionName);
  const finish = recordingFinishMock(session);
  sessionStore.publish(sessionName, session);
  const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();

  await expect(
    handleSessionCommands({
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      lifecycleOperationsLoader: loader,
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

  expect(sessionStore.get(sessionName)).toBeDefined();
  expect(fs.existsSync(scriptPath)).toBe(false);
  expect(finish).not.toHaveBeenCalled();
  expect(session.screenRecording).toBeDefined();
  expect(finalizeApplicationClose).not.toHaveBeenCalled();

  const plainClose = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    lifecycleOperationsLoader: loader,
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
  expect(finalizeApplicationClose).toHaveBeenCalledWith(
    expect.objectContaining({ retainRunner: false }),
  );
  expect(sessionStore.get(sessionName)).toBeUndefined();
});
