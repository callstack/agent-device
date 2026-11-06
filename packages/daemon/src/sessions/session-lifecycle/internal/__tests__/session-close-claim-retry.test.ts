import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LeaseLifecycleProvider } from '@agent-device/contracts/device';
import {
  sessionCloseShutdownFixture,
  type SessionState,
} from './session-close-shutdown.fixtures.ts';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import { lifecycleOperationsSpy } from '../../../../__tests__/support/lifecycle-operations-spy.ts';

bindTestCommandHost();

const {
  acquireDeviceClaim,
  AppError,
  flushDiagnosticsToSessionFile,
  fs,
  handleSessionCommands,
  inspectDeviceClaims,
  LeaseRegistry,
  makeSession,
  makeSessionStore,
  mkdtempForTestSync,
  noopInvoke,
  path,
  resetSessionCloseShutdownMocks,
  withDiagnosticsScope,
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

type LeaseRegistryInstance = InstanceType<typeof LeaseRegistry>;

async function openSession(
  sessionName: string,
  options: Readonly<{
    claim?: false;
    lease?: Readonly<{ registry: LeaseRegistryInstance; retainOnClose?: true }>;
    scriptPublication?: SessionState['scriptPublication'];
  }> = {},
) {
  const sessionStore = makeSessionStore();
  const acquired =
    options.claim === false ? undefined : await claimDevice(sessionStore, sessionName);
  if (acquired && acquired.status !== 'acquired') {
    throw new Error('expected the test session to acquire a device claim');
  }
  const lease = options.lease?.registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'android-instance',
    deviceKey: 'android:' + device.id,
    ...(options.lease.retainOnClose ? { retainOnClose: true } : {}),
  });
  sessionStore.publish(sessionName, {
    ...makeSession(sessionName, device),
    appBundleId: 'com.example.app',
    ...(acquired ? { deviceClaim: acquired.ownership } : {}),
    ...(options.scriptPublication ? { scriptPublication: options.scriptPublication } : {}),
    ...(lease
      ? {
          lease: {
            leaseId: lease.leaseId,
            tenantId: lease.tenantId,
            runId: lease.runId,
            leaseBackend: lease.backend,
            deviceKey: lease.deviceKey,
          },
        }
      : {}),
  });
  return sessionStore;
}

function close(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
  loader: ReturnType<typeof lifecycleOperationsSpy>['loader'],
  options: Readonly<{
    leaseRegistry?: LeaseRegistryInstance;
    leaseLifecycleProvider?: LeaseLifecycleProvider;
    saveScript?: true;
  }> = {},
) {
  return handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    lifecycleOperationsLoader: loader,
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: options.saveScript ? { saveScript: true } : {},
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    ...(options.leaseRegistry ? { leaseRegistry: options.leaseRegistry } : {}),
    ...(options.leaseLifecycleProvider
      ? { leaseLifecycleProvider: options.leaseLifecycleProvider }
      : {}),
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
  const sessionStore = await openSession(sessionName);
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
  const sessionStore = await openSession(sessionName);
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

test('a leased session keeps its lease until a retried close confirms the cleanup', async () => {
  const sessionName = 'close-retry-keeps-lease';
  const leaseRegistry = new LeaseRegistry();
  const sessionStore = await openSession(sessionName, { lease: { registry: leaseRegistry } });
  const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
  finalizeApplicationClose.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'adb timed out after 5000ms'),
  );

  await expect(close(sessionStore, sessionName, loader, { leaseRegistry })).rejects.toMatchObject(
    cleanupIncomplete,
  );
  expect(leaseRegistry.listActiveLeases()).toHaveLength(1);

  const retried = await close(sessionStore, sessionName, loader, { leaseRegistry });

  expect(retried).toMatchObject({ ok: true });
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
  expect(inspectDeviceClaims({ serial: device.id }, process.env)).toEqual([]);
});

// Only a withheld claim keeps the session. Without one, a failed close retires the session as it
// always did, so no kept session is left that the retry hint could not close.
test.each([
  { lease: 'released on close', retainOnClose: undefined, activeLeases: 0 },
  { lease: 'retained on close', retainOnClose: true as const, activeLeases: 1 },
])(
  'a failed close retires a leased session without a claim (lease $lease)',
  async ({ retainOnClose, activeLeases }) => {
    const sessionName = 'close-failure-claimless-lease';
    const leaseRegistry = new LeaseRegistry();
    const sessionStore = await openSession(sessionName, {
      claim: false,
      lease: { registry: leaseRegistry, ...(retainOnClose ? { retainOnClose } : {}) },
    });
    const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
    finalizeApplicationClose.mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'adb timed out after 5000ms'),
    );

    await expect(close(sessionStore, sessionName, loader, { leaseRegistry })).rejects.toMatchObject(
      cleanupIncomplete,
    );

    expect(sessionStore.get(sessionName)).toBeUndefined();
    expect(leaseRegistry.listActiveLeases()).toHaveLength(activeLeases);
  },
);

test('after a close --save-script publishes and its cleanup fails, a plain close releases the claim', async () => {
  const sessionName = 'close-save-script-retry';
  const scriptPath = path.join(mkdtempForTestSync('agent-device-close-retry-script-'), 'flow.ad');
  const sessionStore = await openSession(sessionName, {
    scriptPublication: {
      kind: 'authoring',
      status: 'armed',
      target: { kind: 'explicit', path: scriptPath, force: false },
    },
  });
  const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
  finalizeApplicationClose.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'adb timed out after 5000ms'),
  );

  await expect(
    close(sessionStore, sessionName, loader, { saveScript: true }),
  ).rejects.toMatchObject(cleanupIncomplete);
  expect(fs.existsSync(scriptPath)).toBe(true);
  await expect(
    close(sessionStore, sessionName, loader, { saveScript: true }),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
  });
  expect(sessionStore.get(sessionName)).toBeDefined();

  await expect(close(sessionStore, sessionName, loader)).resolves.toMatchObject({ ok: true });
  expect(inspectDeviceClaims({ serial: device.id }, process.env)).toEqual([]);
});

// A failed provider release keeps a claimless session for its own retry. The cleanup failure report,
// whose hint says the session was retired, is built only once the close does retire the session.
test.each([
  { failure: 'only the lease release fails', cleanupFails: false },
  { failure: 'cleanup and the lease release fail', cleanupFails: true },
])(
  'a claimless close where $failure keeps the session without a retired-session report',
  async ({ cleanupFails }) => {
    const sessionName = 'close-lease-release-failure';
    const leaseRegistry = new LeaseRegistry();
    const sessionStore = await openSession(sessionName, {
      claim: false,
      lease: { registry: leaseRegistry },
    });
    const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
    if (cleanupFails) {
      finalizeApplicationClose.mockRejectedValueOnce(
        new AppError('COMMAND_FAILED', 'adb timed out after 5000ms'),
      );
    }
    const release = vi
      .fn<NonNullable<LeaseLifecycleProvider['release']>>()
      .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'provider unreachable'))
      .mockResolvedValue(undefined);
    const options = { leaseRegistry, leaseLifecycleProvider: { release } };
    const diagnosticsLogPath = path.join(claimsRoot, 'diagnostics.ndjson');

    const failed = await withDiagnosticsScope(
      { session: sessionName, command: 'close', logPath: diagnosticsLogPath },
      async () => {
        const response = await close(sessionStore, sessionName, loader, options);
        flushDiagnosticsToSessionFile({ force: true });
        return response;
      },
    );

    expect(failed).toMatchObject({ ok: false, error: { code: 'COMMAND_FAILED', retriable: true } });
    expect(sessionStore.get(sessionName)).toBeDefined();
    const phases = fs.existsSync(diagnosticsLogPath)
      ? fs
          .readFileSync(diagnosticsLogPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).phase)
      : [];
    expect(phases).not.toContain('session_close_cleanup_failed');

    await expect(close(sessionStore, sessionName, loader, options)).resolves.toMatchObject({
      ok: true,
    });
    expect(sessionStore.get(sessionName)).toBeUndefined();
    expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
  },
);
