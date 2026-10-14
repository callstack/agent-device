import { beforeEach, expect, test } from 'vitest';
import { composedPlatformServicesFixture } from '../platform-services-fixture.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { fakeCreateCommandSurface } from '../../../daemon/__tests__/support/command-surface-fake.ts';
import { composedLifecycleRuntimeFixture } from '../application-lifecycle-runtime-fixture.ts';
import { sessionCloseShutdownFixture } from '../../../daemon/session-lifecycle/internal/__tests__/session-close-shutdown.fixtures.ts';

const {
  handleSessionCommands: handleHarnessSessionCommands,
  makeSession,
  makeSessionStore,
  mockShutdownTargetRuntime,
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

// The shutdown-gating rule lives in the real Apple/Android close finalization: a physical device
// (or any Android device) ignores `close --shutdown`. The canned port fixture answers finalize
// without platform gating, so these cases run in the composition lane.
beforeEach(resetSessionCloseShutdownMocks);

test('close --shutdown is ignored for non-simulator iOS devices', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-shutdown-session';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'physical-device-1',
      name: 'My iPhone',
      kind: 'device',
      booted: true,
    }),
  );

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)).toBeUndefined();
  if (response && response.ok) {
    expect(response.data?.session).toBe(sessionName);
    expect(response.data?.shutdown).toBeUndefined();
  }
});

test('close --shutdown is ignored for Android devices', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-device-shutdown-session';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'R5CT123456A',
      name: 'Pixel 9',
      kind: 'device',
      booted: true,
    }),
  );

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)).toBeUndefined();
  if (response && response.ok) {
    expect(response.data?.session).toBe(sessionName);
    expect(response.data?.shutdown).toBeUndefined();
  }
});
