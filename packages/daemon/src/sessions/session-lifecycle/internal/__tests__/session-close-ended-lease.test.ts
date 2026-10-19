import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  bindTestCommandHost,
  createLiveTestHostEnvironment,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { SessionStore } from '../../../../core/session-store.ts';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonRequest } from '../../../../core/daemon-request.ts';
import type { SessionState } from '../../../../core/session-state.ts';
import { LeaseRegistry } from '../../../../resources/lease-registry.ts';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import { handleSessionCommands } from '../../../../__tests__/support/handlers/session-command-harness.ts';
import { dispatchApplicationLifecycleEffect } from '../../../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import type { EndedLeaseLedger } from '../../../../core/request-ended-leases.ts';

bindTestCommandHost();

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({ ok: true, data: {} });
const SESSION_NAME = 'close-ended-lease';

beforeEach(() => {
  vi.clearAllMocks();
});

function leasedSession(leaseRegistry: LeaseRegistry, retainOnClose?: true): SessionState {
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'android-instance',
    leaseProvider: 'proxy',
    deviceKey: 'android:emulator-5554',
    clientId: 'client-a',
    ...(retainOnClose ? { retainOnClose } : {}),
  });
  return {
    ...unleasedSession(),
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
      deviceKey: lease.deviceKey,
      clientId: lease.clientId,
    },
  };
}

function unleasedSession(): SessionState {
  return {
    name: SESSION_NAME,
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
  };
}

function close(
  session: SessionState,
  leaseRegistry: LeaseRegistry,
  positionals: string[] = [],
): { response: Promise<DaemonResponse | null>; endedLeases: EndedLeaseLedger } {
  const root = mkdtempForTestSync('agent-device-session-close-ended-lease-');
  const sessionStore = new SessionStore(
    path.join(root, 'sessions'),
    createLiveTestHostEnvironment(),
  );
  sessionStore.publish(SESSION_NAME, session);
  const endedLeases: EndedLeaseLedger = [];
  const response = handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: SESSION_NAME,
      command: 'close',
      positionals,
      flags: {},
      internal: { endedLeases },
    },
    sessionName: SESSION_NAME,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry,
    invoke: noopInvoke,
  });
  return { response, endedLeases };
}

test('close records the lease it released on the request ledger', async () => {
  const leaseRegistry = new LeaseRegistry();
  const session = leasedSession(leaseRegistry);

  const { response, endedLeases } = close(session, leaseRegistry);

  expect(await response).toMatchObject({ ok: true });
  expect(endedLeases).toEqual([{ leaseId: session.lease?.leaseId, outcome: 'released' }]);
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});

test('close records a lease released before its lease-end teardown reached the session', async () => {
  const leaseRegistry = new LeaseRegistry();
  const session = leasedSession(leaseRegistry);
  const lease = session.lease!;
  const { released } = leaseRegistry.releaseLease({
    leaseId: lease.leaseId,
    tenantId: lease.tenantId,
    runId: lease.runId,
    leaseBackend: lease.leaseBackend,
    leaseProvider: lease.leaseProvider,
    deviceKey: lease.deviceKey,
    clientId: lease.clientId,
  });
  expect(released).toBe(true);

  const { response, endedLeases } = close(session, leaseRegistry);

  expect(await response).toMatchObject({ ok: true });
  expect(endedLeases).toEqual([{ leaseId: lease.leaseId, outcome: 'released' }]);
});

test('close records no ended lease for a retainOnClose lease or a session without one', async () => {
  const leaseRegistry = new LeaseRegistry();
  for (const session of [leasedSession(leaseRegistry, true), unleasedSession()]) {
    const { response, endedLeases } = close(session, leaseRegistry);

    expect(await response).toMatchObject({ ok: true });
    expect(endedLeases).toEqual([]);
  }
  expect(leaseRegistry.listActiveLeases()).toHaveLength(1);
});

test('a close that fails after releasing its lease still records the release', async () => {
  const leaseRegistry = new LeaseRegistry();
  const session = { ...leasedSession(leaseRegistry), appBundleId: 'com.example.app' };
  mockDispatch.mockRejectedValueOnce(
    new AppError('DEVICE_UNAVAILABLE', 'platform close failed', { reason: 'device_disconnected' }),
  );

  const { response, endedLeases } = close(session, leaseRegistry, ['com.example.app']);

  await expect(response).rejects.toMatchObject({ code: 'DEVICE_UNAVAILABLE' });
  expect(endedLeases).toEqual([{ leaseId: session.lease?.leaseId, outcome: 'released' }]);
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});
