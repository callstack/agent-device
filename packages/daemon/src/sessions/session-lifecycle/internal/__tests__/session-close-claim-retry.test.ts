import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { sessionCloseShutdownFixture } from './session-close-shutdown.fixtures.ts';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import { lifecycleOperationsSpy } from '../../../../__tests__/support/lifecycle-operations-spy.ts';

bindTestCommandHost();

const {
  acquireDeviceClaim,
  AppError,
  fs,
  handleSessionCommands,
  inspectDeviceClaims,
  makeSession,
  makeSessionStore,
  mkdtempForTestSync,
  noopInvoke,
  path,
  resetSessionCloseShutdownMocks,
} = sessionCloseShutdownFixture;

// #4237: a close whose cleanup failed withheld the device claim but retired the session, so a
// retried close answered SESSION_NOT_FOUND and only a daemon restart freed the device.

const device = {
  platform: 'android' as const,
  id: 'emulator-5590',
  name: 'Pixel 6 Pro',
  kind: 'emulator' as const,
  booted: true,
};

let claimsRoot: string;
let previousClaimsDir: string | undefined;

beforeEach(() => {
  resetSessionCloseShutdownMocks();
  claimsRoot = mkdtempForTestSync('agent-device-session-close-claim-retry-');
  previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsRoot;
});

afterEach(() => {
  if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
  fs.rmSync(claimsRoot, { recursive: true, force: true });
});

function claimDevice(
  sessionStore: ReturnType<typeof makeSessionStore>,
  session: string,
): ReturnType<typeof acquireDeviceClaim> {
  return acquireDeviceClaim({
    env: process.env,
    device,
    session,
    workspace: process.cwd(),
    stateDir: sessionStore.resolveDaemonStateDir(),
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test-no-recovery' }),
  });
}

async function openClaimedSession(sessionName: string) {
  const sessionStore = makeSessionStore();
  const acquired = await claimDevice(sessionStore, sessionName);
  if (acquired.status !== 'acquired') {
    throw new Error('expected the test session to acquire a device claim');
  }
  sessionStore.publish(sessionName, {
    ...makeSession(sessionName, device),
    appBundleId: 'com.example.app',
    deviceClaim: acquired.ownership,
  });
  return sessionStore;
}

function close(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
  loader: ReturnType<typeof lifecycleOperationsSpy>['loader'],
) {
  return handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    lifecycleOperationsLoader: loader,
    req: { token: 't', session: sessionName, command: 'close', positionals: [], flags: {} },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
}

const cleanupIncomplete = {
  code: 'COMMAND_FAILED',
  details: expect.objectContaining({
    reason: 'session_cleanup_incomplete',
    failedSteps: ['application_lifecycle'],
  }),
};

test('a retried close reruns the failed cleanup and then releases the device claim', async () => {
  const sessionName = 'close-retry-releases-claim';
  const sessionStore = await openClaimedSession(sessionName);
  const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
  finalizeApplicationClose.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'adb timed out after 5000ms'),
  );

  await expect(close(sessionStore, sessionName, loader)).rejects.toMatchObject(cleanupIncomplete);
  expect(sessionStore.get(sessionName)).toBeDefined();
  expect(inspectDeviceClaims({ serial: device.id }, process.env)[0]?.claim?.session).toBe(
    sessionName,
  );

  const retried = await close(sessionStore, sessionName, loader);

  expect(retried).toMatchObject({ ok: true, data: { session: sessionName } });
  expect(finalizeApplicationClose).toHaveBeenCalledTimes(2);
  expect(sessionStore.get(sessionName)).toBeUndefined();
  expect(inspectDeviceClaims({ serial: device.id }, process.env)).toEqual([]);
  await expect(claimDevice(sessionStore, 'next-session')).resolves.toMatchObject({
    status: 'acquired',
  });
});

test('a close whose cleanup keeps failing keeps the session closable and the device claimed', async () => {
  const sessionName = 'close-retry-still-failing';
  const sessionStore = await openClaimedSession(sessionName);
  const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
  finalizeApplicationClose.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'adb timed out after 5000ms'),
  );

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await expect(close(sessionStore, sessionName, loader)).rejects.toMatchObject(cleanupIncomplete);
    expect(finalizeApplicationClose).toHaveBeenCalledTimes(attempt);
    expect(sessionStore.get(sessionName)).toBeDefined();
  }

  const [claim] = inspectDeviceClaims({ serial: device.id }, process.env);
  expect(claim?.classification).toBe('live');
  expect(claim?.claim?.session).toBe(sessionName);
  await expect(claimDevice(sessionStore, 'next-session')).resolves.toMatchObject({
    status: 'conflict',
  });
});
