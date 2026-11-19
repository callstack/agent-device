import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  sessionCloseShutdownFixture,
  type SessionState,
} from './session-close-shutdown.fixtures.ts';
import {
  mkdtempForTestSync,
  bindTestCommandHost,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import { lifecycleOperationsSpy } from '../../../../__tests__/support/lifecycle-operations-spy.ts';
import { platformResourceCleanupFixture } from '../../../../__tests__/support/platform-resource-cleanup-fixture.ts';
import {
  acquireDeviceClaim,
  clearDeviceClaim,
  inspectDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import {
  launchedEmulatorProcess,
  resetLaunchedEmulatorProcess,
} from '../../../../__tests__/support/launched-emulator-process-fixture.ts';

// The host's answers about the emulator process an `open` launched are modelled, so an Android case
// can settle its close without touching the real process table.
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const { launchedEmulatorProcessHost } =
    await import('../../../../__tests__/support/launched-emulator-process-fixture.ts');
  return launchedEmulatorProcessHost(
    await importOriginal<typeof import('@agent-device/host-kit/process')>(),
  );
});

bindTestCommandHost();

const {
  AppError,
  handleSessionCommands,
  makeSession,
  makeSessionStore,
  mockShutdownTargetRuntime,
  noopInvoke,
  path,
  resetSessionCloseShutdownMocks,
} = sessionCloseShutdownFixture;

beforeEach(() => {
  resetSessionCloseShutdownMocks();
  resetLaunchedEmulatorProcess();
});

const iosSimulator: SessionState['device'] = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-udid-implicit',
  name: 'iPhone 15',
  kind: 'simulator',
  // Selection records the boot from the stopped state, and the session keeps that snapshot.
  booted: false,
};

const androidEmulator: SessionState['device'] = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel_9_API_35',
  kind: 'emulator',
  booted: false,
};

async function closeSession(params: {
  sessionName: string;
  device: SessionState['device'];
  bootedByOpen?: true;
  claim?: 'missing' | 'successor';
  flags?: Record<string, unknown>;
  deviceShutdownDenied?: boolean;
  lifecycleOperationsLoader?: Parameters<
    typeof handleSessionCommands
  >[0]['lifecycleOperationsLoader'];
  platformResourceCleanup?: ReturnType<typeof platformResourceCleanupFixture>;
}) {
  const { sessionName, device, bootedByOpen, flags } = params;
  const host = createTestHostEnvironment({
    env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: mkdtempForTestSync('implicit-close-claims-') },
  });
  const sessionStore = makeSessionStore();
  const session = makeSession(sessionName, device);
  if (bootedByOpen) session.bootedByOpen = bootedByOpen;
  if (device.platform === 'android')
    session.androidLaunchIdentity = {
      pid: launchedEmulatorProcess.pid,
      startTime: launchedEmulatorProcess.startTime,
    };
  if (bootedByOpen) {
    const claimInput = {
      env: host.env,
      device,
      session: sessionName,
      workspace: host.cwd,
      stateDir: sessionStore.resolveDaemonStateDir(),
      reconcileOrphanedDeviceClaim: async () => ({ status: 'reconciled' as const }),
    };
    const acquired = await acquireDeviceClaim(claimInput);
    if (acquired.status !== 'acquired') throw new Error('Expected an owned device claim');
    session.deviceClaim = acquired.ownership;
    if (params.claim === 'missing') {
      await clearDeviceClaim(acquired.ownership, host.env);
    }
    if (params.claim === 'successor') {
      const prior = inspectDeviceClaims({}, host.env)[0]?.claim;
      if (!prior) throw new Error('Expected the original claim');
      const successor = await acquireDeviceClaim({
        ...claimInput,
        session: 'successor-session',
        stateDir: path.join(sessionStore.resolveDaemonStateDir(), 'successor-state'),
        observeDeviceBoot: {
          observeBootTimeMs: async () => ({ observed: true, bootedAtMs: prior.updatedAtMs + 1 }),
        },
      });
      expect(successor.status).toBe('acquired');
    }
  }
  sessionStore.publish(sessionName, session);
  const response = await handleSessionCommands({
    host,
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture({
      deviceBootObservation: {
        observeBootTimeMs: async () => ({ observed: false, reason: 'unobserved' }),
      },
    }),
    ...(params.lifecycleOperationsLoader
      ? { lifecycleOperationsLoader: params.lifecycleOperationsLoader }
      : {}),
    ...(params.platformResourceCleanup
      ? { platformResourceCleanup: params.platformResourceCleanup }
      : {}),
    deviceShutdownDenied: params.deviceShutdownDenied,
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: flags ?? {},
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  return { response, sessionStore, claims: inspectDeviceClaims({}, host.env) };
}

test.each([
  ['missing', false],
  ['missing', true],
  ['successor', false],
  ['successor', true],
] as const)(
  'plain close cannot stop a boot-owned device when its current claim is %s and policy denial is %s',
  async (claim, deviceShutdownDenied) => {
    const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
    const { response, sessionStore, claims } = await closeSession({
      sessionName: 'lost-claim-session',
      device: iosSimulator,
      bootedByOpen: true,
      claim,
      deviceShutdownDenied,
      lifecycleOperationsLoader: loader,
    });
    expect(response?.ok).toBe(true);
    if (response?.ok) {
      expect(response.data?.warnings).toEqual([
        "This session's open booted this device, but close could not verify its device claim and did not request a stop.",
      ]);
    }
    expect(finalizeApplicationClose).toHaveBeenCalledWith(
      expect.objectContaining({ shutdownTarget: false }),
    );
    expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
    expect(sessionStore.get('lost-claim-session')).toBeUndefined();
    expect(claims.map((entry) => entry.claim?.session)).toEqual(
      claim === 'successor' ? ['successor-session'] : [],
    );
  },
);

test.each([
  { label: 'iOS simulator', device: iosSimulator },
  { label: 'Android emulator', device: androidEmulator },
])(
  'plain close stops the $label this session booted and reports it in data.shutdown',
  async ({ device }) => {
    const { response, sessionStore } = await closeSession({
      sessionName: 'implicit-shutdown-session',
      device,
      bootedByOpen: true,
    });

    expect(response?.ok).toBe(true);
    expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
    expect(sessionStore.get('implicit-shutdown-session')).toBeUndefined();
    if (response?.ok) {
      expect(response.data?.session).toBe('implicit-shutdown-session');
      expect(response.data?.shutdown).toEqual({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
    }
  },
);

test.each([
  { label: 'iOS simulator', device: { ...iosSimulator, booted: true } },
  { label: 'Android emulator', device: { ...androidEmulator, booted: true } },
])(
  'plain close leaves the already-booted $label running and reports no shutdown',
  async ({ device }) => {
    const { response, sessionStore } = await closeSession({
      sessionName: 'prebooted-session',
      device,
    });

    expect(response?.ok).toBe(true);
    expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
    expect(sessionStore.get('prebooted-session')).toBeUndefined();
    if (response?.ok) expect(response.data?.shutdown).toBeUndefined();
  },
);

test.each([
  {
    label: 'a physical iOS device',
    device: {
      platform: 'apple' as const,
      appleOs: 'ios' as const,
      id: 'physical-implicit-1',
      name: 'My iPhone',
      kind: 'device' as const,
      booted: false,
    },
  },
  {
    label: 'a physical Android device',
    device: {
      platform: 'android' as const,
      id: 'R5CT123456A',
      name: 'Pixel 9',
      kind: 'device' as const,
      booted: false,
    },
  },
])(
  'plain close on $label leaves the stop to the platform, which reports none',
  async ({ device }) => {
    // Selection never records a boot for these kinds. The close may still ask the admitted platform
    // to finalize with a stop, and the platform answers with no shutdown result.
    const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
    const { response } = await closeSession({
      sessionName: 'physical-session',
      device,
      lifecycleOperationsLoader: loader,
    });

    expect(response?.ok).toBe(true);
    expect(finalizeApplicationClose).toHaveBeenCalledWith(
      expect.objectContaining({ shutdownTarget: false }),
    );
    expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
    if (response?.ok) expect(response.data?.shutdown).toBeUndefined();
  },
);

test('plain close on a provider-owned session never asks the local-family stop', async () => {
  // The boot fact cannot come from a provider selection. Even a record that carries one must not
  // route a provider session through the local shutdown capability.
  const sessionStore = makeSessionStore();
  const sessionName = 'provider-implicit-session';
  const device: SessionState['device'] = {
    platform: 'apple',
    appleOs: 'ios',
    id: 'limrun:ios:lease-implicit',
    name: 'Limrun iOS',
    kind: 'simulator',
    booted: false,
  };
  const session = makeSession(sessionName, device);
  session.bootedByOpen = true;
  sessionStore.publish(sessionName, session);
  const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
  const facts = sessionCloseShutdownFixture.lifecycleRuntimeFacts(device);
  const providerFacts = {
    ...facts,
    device: { ...facts.device, providerMode: 'provider-runtime' as const },
  };
  sessionCloseShutdownFixture.mockInspectDeviceRuntimeFacts
    .mockResolvedValueOnce(providerFacts)
    .mockResolvedValueOnce(providerFacts);
  sessionCloseShutdownFixture.mockBindDeviceRuntime.mockImplementationOnce(
    async (candidate, use) =>
      await sessionCloseShutdownFixture.narrowDeviceBinding(
        {
          device: candidate,
          owner: sessionCloseShutdownFixture.providerRuntimeOwner('limrun', 'lease-implicit'),
          facts: providerFacts,
          operations: await loader(candidate),
          [Symbol.asyncDispose]: async () => undefined,
        },
        use,
      ),
  );

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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
  expect(finalizeApplicationClose).toHaveBeenCalledWith(
    expect.objectContaining({ shutdownTarget: false }),
  );
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
});

test('plain close on a boot-owned device finalizes without a retained runner and without retention', async () => {
  const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
  const platformResourceCleanup = platformResourceCleanupFixture();
  const { response } = await closeSession({
    sessionName: 'implicit-retain-session',
    device: iosSimulator,
    bootedByOpen: true,
    lifecycleOperationsLoader: loader,
    platformResourceCleanup,
  });

  expect(response?.ok).toBe(true);
  expect(finalizeApplicationClose).toHaveBeenCalledWith(
    expect.objectContaining({ shutdownTarget: true, retainRunner: false }),
  );
  expect(platformResourceCleanup.retainExecutionHostAfterClose).toHaveBeenCalledWith(
    expect.objectContaining({ device: iosSimulator, shutdownRequested: true }),
  );
});

test('close --shutdown keeps asking for the stop on a session that did not boot its device', async () => {
  const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
  const { response } = await closeSession({
    sessionName: 'explicit-shutdown-session',
    device: { ...iosSimulator, booted: true },
    flags: { shutdown: true },
    lifecycleOperationsLoader: loader,
  });

  expect(response?.ok).toBe(true);
  expect(finalizeApplicationClose).toHaveBeenCalledWith(
    expect.objectContaining({ shutdownTarget: true }),
  );
});

test('a policy that denies the stop keeps close successful, keeps the runner warm, and reports the kept device', async () => {
  // Runtime composition derives this fact from the loaded daemon policy (ADR 0029). The close
  // lifecycle reads it BEFORE finalizing, so the refused stop never consumes the runner retention.
  const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
  const platformResourceCleanup = platformResourceCleanupFixture({
    retainExecutionHostAfterClose: () => true,
  });
  const { response, sessionStore } = await closeSession({
    sessionName: 'policy-denied-session',
    device: iosSimulator,
    bootedByOpen: true,
    deviceShutdownDenied: true,
    lifecycleOperationsLoader: loader,
    platformResourceCleanup,
  });

  expect(finalizeApplicationClose).toHaveBeenCalledWith(
    expect.objectContaining({ shutdownTarget: false, retainRunner: true }),
  );
  // The refused stop never reaches the retention question, so a device kept running still earns
  // the warm-runner answer the cleanup gives an ordinary close.
  expect(platformResourceCleanup.retainExecutionHostAfterClose).toHaveBeenCalledWith(
    expect.objectContaining({ device: iosSimulator, shutdownRequested: false }),
  );
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(response?.ok).toBe(true);
  expect(sessionStore.get('policy-denied-session')).toBeUndefined();
  if (response?.ok) {
    expect(response.data?.session).toBe('policy-denied-session');
    expect(response.data?.shutdown).toBeUndefined();
    expect(response.data?.warnings).toEqual([
      "This session's open booted this device and close would stop it, but this daemon's policy denies device-shutdown. The device is still running.",
    ]);
  }
});

test('a denied policy fact without boot ownership changes nothing', async () => {
  const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();
  const { response } = await closeSession({
    sessionName: 'policy-denied-unowned-session',
    device: { ...iosSimulator, booted: true },
    deviceShutdownDenied: true,
    lifecycleOperationsLoader: loader,
  });

  expect(finalizeApplicationClose).toHaveBeenCalledWith(
    expect.objectContaining({ shutdownTarget: false }),
  );
  expect(response?.ok).toBe(true);
  if (response?.ok) expect(response.data?.warnings).toBeUndefined();
});

test('a failed finalization keeps failing an explicit close --shutdown', async () => {
  // The request gate refuses a policy-denied `--shutdown` before the handler (daemon-policy.ts),
  // covered there. This is the handler half: whatever the reason, a stop the platform cannot
  // complete fails the close with the incomplete-cleanup report — an implicit convenience stop
  // would not, which is what the boot-ownership tests above pin.
  const shutdownFailed = new AppError('COMMAND_FAILED', 'Emulator refused to shut down.', {
    reason: 'shutdown-failed',
    retriable: true,
  });
  const { loader } = lifecycleOperationsSpy({
    finalizeApplicationClose: async () => {
      throw shutdownFailed;
    },
  });
  const sessionStore = makeSessionStore();
  const sessionName = 'failed-explicit-shutdown-session';
  const session = makeSession(sessionName, { ...iosSimulator, booted: true });
  sessionStore.publish(sessionName, session);

  await expect(
    handleSessionCommands({
      host: createTestHostEnvironment(),
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      lifecycleOperationsLoader: loader,
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
    }),
  ).rejects.toMatchObject({
    details: { reason: 'session_cleanup_incomplete', failedSteps: ['application_lifecycle'] },
  });
});
