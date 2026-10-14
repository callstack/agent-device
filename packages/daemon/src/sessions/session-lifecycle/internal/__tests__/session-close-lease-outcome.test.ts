import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { SessionStore } from '../../../../core/session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../../../../core/daemon-request.ts';
import type { SessionState } from '../../../../core/session-state.ts';
import { LeaseRegistry } from '../../../../resources/lease-registry.ts';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import { handleSessionCommands } from '../../../../__tests__/support/handlers/session-command-harness.ts';
import { dispatchApplicationLifecycleEffect } from '../../../../__tests__/support/application-lifecycle-runtime-fixture.ts';

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({ ok: true, data: {} });
const SESSION_NAME = 'close-lease-outcome';

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

async function close(
  session: SessionState,
  leaseRegistry: LeaseRegistry,
  positionals: string[] = [],
): Promise<DaemonResponse | null> {
  const root = mkdtempForTestSync('agent-device-session-close-lease-outcome-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.publish(SESSION_NAME, session);
  return await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: { token: 't', session: SESSION_NAME, command: 'close', positionals, flags: {} },
    sessionName: SESSION_NAME,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry,
    invoke: noopInvoke,
  });
}

test('close reports the lease it released', async () => {
  const leaseRegistry = new LeaseRegistry();
  const session = leasedSession(leaseRegistry);

  const response = await close(session, leaseRegistry);

  expect(response).toMatchObject({
    ok: true,
    data: { lease: { outcome: 'released', leaseId: session.lease?.leaseId } },
  });
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});

test('close reports a retainOnClose lease as retained and keeps it', async () => {
  const leaseRegistry = new LeaseRegistry();
  const session = leasedSession(leaseRegistry, true);

  const response = await close(session, leaseRegistry);

  expect(response).toMatchObject({
    ok: true,
    data: { lease: { outcome: 'retained', leaseId: session.lease?.leaseId } },
  });
  expect(leaseRegistry.listActiveLeases()).toHaveLength(1);
});

test('close reports no lease for a session without a daemon lease', async () => {
  const response = await close(unleasedSession(), new LeaseRegistry());

  expect(response).toMatchObject({ ok: true, data: { lease: { outcome: 'none' } } });
});

test('a close that fails after releasing its lease reports the release in the error', async () => {
  const leaseRegistry = new LeaseRegistry();
  const session = { ...leasedSession(leaseRegistry), appBundleId: 'com.example.app' };
  mockDispatch.mockRejectedValueOnce(
    new AppError('DEVICE_UNAVAILABLE', 'platform close failed', { reason: 'device_disconnected' }),
  );

  const failure = await close(session, leaseRegistry, ['com.example.app']).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(AppError);
  expect(failure).toMatchObject({
    code: 'DEVICE_UNAVAILABLE',
    details: {
      reason: 'device_disconnected',
      lease: { outcome: 'released', leaseId: session.lease?.leaseId },
    },
  });
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});
