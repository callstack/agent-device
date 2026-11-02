import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { CloseApplicationFinalizationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindTestCommandHost,
  createLiveTestHostEnvironment,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { SessionStore } from '../../../core/session-store.ts';
import { LeaseRegistry } from '../../../resources/lease-registry.ts';
import { createLeaseSessionEnd } from '../../../server/request-execution-scope.ts';
import { handleLeaseCommands } from '../../handlers/lease.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import { platformResourceCleanupFixture } from '../../../__tests__/support/platform-resource-cleanup-fixture.ts';
import {
  clearRuntimeHintsFixture,
  dispatchApplicationLifecycleEffect,
} from '../../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
} from '../../../__tests__/support/handlers/session-command-harness.ts';

bindTestCommandHost();

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({ ok: true, data: {} });

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-close-teardown-');
  return new SessionStore(path.join(root, 'sessions'), createLiveTestHostEnvironment());
}

function publishSession(
  sessionStore: SessionStore,
  name: string,
  device: DeviceInfo,
  overrides: Partial<SessionState> = {},
): SessionState {
  const session: SessionState = {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
    appName: 'com.example.app',
    ...overrides,
  };
  sessionStore.publish(name, session);
  return session;
}

async function closeSession(params: {
  sessionStore: SessionStore;
  sessionName: string;
  retainExecutionHost: boolean;
  positionals?: string[];
  flags?: Record<string, unknown>;
  internal?: DaemonRequest['internal'];
  leaseRegistry?: LeaseRegistry;
  events?: string[];
}) {
  const platformResourceCleanup = platformResourceCleanupFixture({
    retainExecutionHostAfterClose: () => params.retainExecutionHost,
  });
  const finalizations: CloseApplicationFinalizationInput[] = [];
  const bindDevice: Parameters<typeof handleSessionCommands>[0]['bindDevice'] = async (
    device,
    use,
  ) => {
    const binding = await mockBindDeviceRuntime(device, use);
    return {
      ...binding,
      operations: {
        ...binding.operations,
        finalizeApplicationClose: async (input: CloseApplicationFinalizationInput) => {
          finalizations.push(input);
          params.events?.push(`finalize:${input.retainRunner ? 'retain' : 'stop'}`);
          return {};
        },
      },
    };
  };
  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    platformResourceCleanup,
    req: {
      token: 't',
      session: params.sessionName,
      command: 'close',
      positionals: params.positionals ?? [],
      flags: params.flags ?? {},
      ...(params.internal === undefined ? {} : { internal: params.internal }),
    },
    ...(params.leaseRegistry === undefined ? {} : { leaseRegistry: params.leaseRegistry }),
    sessionName: params.sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore: params.sessionStore,
    invoke: noopInvoke,
    bindDevice,
  });
  return { response, finalizations, platformResourceCleanup };
}

test.each([
  { name: 'an iOS simulator', device: IOS_SIMULATOR },
  {
    name: 'an iOS simulator in a scoped simulator set',
    device: { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulator-set' },
  },
])(
  'close on $name finalizes with the runner retention the platform decided',
  async ({ device }) => {
    for (const retainExecutionHost of [true, false]) {
      const sessionStore = makeSessionStore();
      const sessionName = `retention-${retainExecutionHost}`;
      publishSession(sessionStore, sessionName, device);

      const { response, finalizations, platformResourceCleanup } = await closeSession({
        sessionStore,
        sessionName,
        retainExecutionHost,
      });

      expect(response?.ok).toBe(true);
      expect(platformResourceCleanup.retainExecutionHostAfterClose).toHaveBeenCalledWith({
        device,
        shutdownRequested: false,
        hasScreenRecording: false,
        leaseWillEnd: false,
      });
      expect(finalizations).toEqual([
        expect.objectContaining({ retainRunner: retainExecutionHost, shutdownTarget: false }),
      ]);
      expect(sessionStore.get(sessionName)).toBeUndefined();
    }
  },
);

test('close <app> terminates the app before finalizing with the platform retention decision', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-close-session';
  publishSession(sessionStore, sessionName, IOS_SIMULATOR);
  const events: string[] = [];
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    events.push(`${command}:${(positionals ?? []).join(' ')}`);
  });

  const { response } = await closeSession({
    sessionStore,
    sessionName,
    retainExecutionHost: true,
    positionals: ['com.example.app'],
    events,
  });

  expect(response?.ok).toBe(true);
  expect(events).toEqual(['close:com.example.app', 'finalize:retain']);
});

test('close hands the session app and surface to the platform finalization', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-session';
  publishSession(
    sessionStore,
    sessionName,
    {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-macos-local',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    },
    { appBundleId: 'com.apple.systempreferences', appName: 'System Settings' },
  );

  const { response, finalizations } = await closeSession({
    sessionStore,
    sessionName,
    retainExecutionHost: false,
  });

  expect(response?.ok).toBe(true);
  expect(finalizations).toEqual([
    expect.objectContaining({ appBundleId: 'com.apple.systempreferences', surface: 'app' }),
  ]);
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test.each([false, true])(
  'close reports whether a lease with retainOnClose=%s will end',
  async (retainOnClose) => {
    const sessionStore = makeSessionStore();
    const sessionName = 'ios-leased-simulator-session';
    const leaseRegistry = new LeaseRegistry();
    const lease = leaseRegistry.allocateLease({
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseBackend: 'ios-simulator',
      deviceKey: 'ios:sim-1',
      clientId: 'client-a',
      retainOnClose,
    });
    publishSession(sessionStore, sessionName, IOS_SIMULATOR, {
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
        deviceKey: lease.deviceKey,
        clientId: lease.clientId,
        expiresAt: lease.expiresAt,
      },
    });

    const { response, finalizations, platformResourceCleanup } = await closeSession({
      sessionStore,
      sessionName,
      retainExecutionHost: retainOnClose,
      leaseRegistry,
    });

    expect(response?.ok).toBe(true);
    expect(platformResourceCleanup.retainExecutionHostAfterClose).toHaveBeenCalledWith(
      expect.objectContaining({ leaseWillEnd: !retainOnClose }),
    );
    expect(finalizations).toEqual([expect.objectContaining({ retainRunner: retainOnClose })]);
    expect(sessionStore.get(sessionName)).toBeUndefined();
    expect(sessionStore.listRetainedExecutionHosts(lease.leaseId)).toEqual(
      retainOnClose
        ? [expect.objectContaining({ address: sessionName, device: IOS_SIMULATOR })]
        : [],
    );
  },
);

test('releasing a retained client lease stops the host after close retired its session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'retained-host-release';
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-simulator',
    deviceKey: 'ios:sim-1',
    clientId: 'client-a',
    retainOnClose: true,
  });
  const leaseScope = {
    leaseId: lease.leaseId,
    tenantId: lease.tenantId,
    runId: lease.runId,
    leaseBackend: lease.backend,
    deviceKey: lease.deviceKey,
    clientId: lease.clientId,
  };
  publishSession(sessionStore, sessionName, IOS_SIMULATOR, { lease: leaseScope });
  const closed = await closeSession({
    sessionStore,
    sessionName,
    retainExecutionHost: true,
    leaseRegistry,
  });
  expect(closed.response?.ok).toBe(true);
  expect(sessionStore.get(sessionName)).toBeUndefined();
  expect(leaseRegistry.listActiveLeases()).toHaveLength(1);
  const cleanup = vi.fn(async () => {});
  const teardown = vi.fn(async () => {});
  const ender = createLeaseSessionEnd({
    env: sessionStore.host.env,
    sessionStore,
    executionLocks: new Map(),
    teardownSession: teardown,
    cleanupSessionlessExecutionHost: cleanup,
  });

  const released = await handleLeaseCommands({
    host: sessionStore.host,
    req: {
      token: 't',
      command: 'lease_release',
      session: sessionName,
      positionals: [],
      meta: leaseScope,
    },
    sessionName,
    sessionStore,
    leaseRegistry,
    endSessionsForLease: async (leaseId) => await ender.end(leaseId, 'LEASE_RELEASED'),
  });

  expect(released?.ok).toBe(true);
  expect(leaseRegistry.listActiveLeases()).toEqual([]);
  expect(teardown).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledExactlyOnceWith(IOS_SIMULATOR);
  expect(sessionStore.listRetainedExecutionHosts(lease.leaseId)).toEqual([]);
});

test('a lease scope mismatch still closes the app and runner before returning a retriable release error', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-close-mismatched-lease';
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-simulator',
    deviceKey: 'ios:sim-1',
    clientId: 'client-a',
    retainOnClose: true,
  });
  publishSession(sessionStore, sessionName, IOS_SIMULATOR, {
    appBundleId: 'com.example.app',
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      deviceKey: lease.deviceKey,
      clientId: 'client-b',
      expiresAt: lease.expiresAt,
    },
  });
  sessionStore.setRuntimeHints(sessionName, { platform: 'ios', metroHost: '127.0.0.1' });

  const { response, finalizations, platformResourceCleanup } = await closeSession({
    sessionStore,
    sessionName,
    retainExecutionHost: false,
    positionals: ['com.example.app'],
    leaseRegistry,
  });

  expect(platformResourceCleanup.stopSnapshotHelper).toHaveBeenCalledWith(IOS_SIMULATOR);
  expect(mockDispatch).toHaveBeenCalledWith(
    IOS_SIMULATOR,
    'close',
    ['com.example.app'],
    undefined,
    expect.any(Object),
  );
  expect(clearRuntimeHintsFixture).toHaveBeenCalledWith({
    device: IOS_SIMULATOR,
    appId: 'com.example.app',
    values: expect.objectContaining({ metroHost: '127.0.0.1' }),
  });
  expect(platformResourceCleanup.retainExecutionHostAfterClose).toHaveBeenCalledWith(
    expect.objectContaining({ leaseWillEnd: true }),
  );
  expect(finalizations).toEqual([expect.objectContaining({ retainRunner: false })]);
  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNAUTHORIZED',
      details: { reason: 'LEASE_SCOPE_MISMATCH', session: sessionName },
      retriable: true,
    },
  });
  expect(sessionStore.get(sessionName)?.lease?.leaseId).toBe(lease.leaseId);
  expect(
    leaseRegistry.getLease({
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      deviceKey: lease.deviceKey,
      clientId: lease.clientId,
    }),
  ).toMatchObject({ retainOnClose: true });
});

test('an app-only close terminates the app without finalizing or ending the session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-app-only-close';
  publishSession(sessionStore, sessionName, IOS_SIMULATOR, { appBundleId: 'com.example.app' });

  const { response, finalizations } = await closeSession({
    sessionStore,
    sessionName,
    retainExecutionHost: true,
    positionals: ['com.example.app'],
    internal: { closeAppOnly: true },
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'sim-1' }),
    'close',
    ['com.example.app'],
    undefined,
    expect.any(Object),
  );
  expect(finalizations).toEqual([]);
  expect(sessionStore.get(sessionName)).toBeDefined();
});

test('close --shutdown tells the platform that shutdown was requested', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'shutdown-session';
  publishSession(sessionStore, sessionName, IOS_SIMULATOR);

  const { finalizations, platformResourceCleanup } = await closeSession({
    sessionStore,
    sessionName,
    retainExecutionHost: false,
    flags: { shutdown: true },
  });

  expect(platformResourceCleanup.retainExecutionHostAfterClose).toHaveBeenCalledWith(
    expect.objectContaining({ shutdownRequested: true }),
  );
  expect(finalizations).toEqual([expect.objectContaining({ shutdownTarget: true })]);
});
