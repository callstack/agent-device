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
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import { platformResourceCleanupFixture } from '../../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { dispatchApplicationLifecycleEffect } from '../../../__tests__/support/application-lifecycle-runtime-fixture.ts';
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
        hasLease: false,
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

test('close of a leased session tells the platform that a lease holds the device', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-leased-simulator-session';
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-simulator',
    deviceKey: 'ios:sim-1',
    clientId: 'client-a',
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
    retainExecutionHost: false,
    leaseRegistry,
  });

  expect(response?.ok).toBe(true);
  expect(platformResourceCleanup.retainExecutionHostAfterClose).toHaveBeenCalledWith(
    expect.objectContaining({ hasLease: true }),
  );
  expect(finalizations).toEqual([expect.objectContaining({ retainRunner: false })]);
  expect(sessionStore.get(sessionName)).toBeUndefined();
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
