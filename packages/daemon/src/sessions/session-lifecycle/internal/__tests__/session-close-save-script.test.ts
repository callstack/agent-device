import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { beforeEach, expect, test } from 'vitest';
import { sessionCloseShutdownFixture } from './session-close-shutdown.fixtures.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';

const {
  handleSessionCommands,
  makeSession,
  makeSessionStore,
  noopInvoke,
  path,
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
