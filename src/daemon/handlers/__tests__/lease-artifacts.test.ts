import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { CloudArtifactsQuery } from '@agent-device/contracts/observability';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { handleLeaseCommands } from '../lease.ts';
import { LeaseRegistry } from '../../lease-registry.ts';

const CLOUD_PROVIDER = 'fake-cloud';

test('artifacts refuses foreign and unknown provider session ids before cloud dispatch', async () => {
  const world = createWorld();
  await allocateLease(world, 'tenant-a', 'run-a');

  await assertProviderSessionNotOwned(world, {
    tenantId: 'tenant-b',
    runId: 'run-b',
    providerSessionId: 'session-tenant-a',
  });
  await assertProviderSessionNotOwned(world, {
    tenantId: 'tenant-a',
    runId: 'run-a',
    providerSessionId: 'session-never-issued',
  });
  await assertProviderSessionNotOwned(world, {
    tenantId: 'tenant-a',
    runId: 'run-a',
    leaseProvider: 'other-cloud',
    providerSessionId: 'session-tenant-a',
  });

  assert.deepEqual(world.providerCalls, []);
});

test('artifacts lists an owned active and recently released provider session', async () => {
  const world = createWorld();
  const lease = await allocateLease(world, 'tenant-a', 'run-a');

  const active = await listArtifacts(world, {
    tenantId: 'tenant-a',
    runId: 'run-a',
    providerSessionId: 'session-tenant-a',
  });
  assert.equal(active.ok, true);
  assert.deepEqual(world.providerCalls, [
    {
      provider: CLOUD_PROVIDER,
      leaseId: lease.leaseId,
      providerSessionId: 'session-tenant-a',
    },
  ]);

  await releaseLease(world, lease);
  world.providerCalls.length = 0;

  const released = await listArtifacts(world, {
    tenantId: 'tenant-a',
    runId: 'run-a',
    providerSessionId: 'session-tenant-a',
  });
  assert.equal(released.ok, true);
  assert.deepEqual(world.providerCalls, [
    {
      provider: CLOUD_PROVIDER,
      leaseId: lease.leaseId,
      providerSessionId: 'session-tenant-a',
    },
  ]);
});

test('artifacts refuses a released provider session after the retention window', async () => {
  let now = 1_000;
  const world = createWorld({
    now: () => now,
    providerSessionRetentionMs: 100,
  });
  const lease = await allocateLease(world, 'tenant-a', 'run-a');

  await releaseLease(world, lease);
  now = 1_050;
  const retained = await listArtifacts(world, {
    tenantId: 'tenant-a',
    runId: 'run-a',
    providerSessionId: 'session-tenant-a',
  });
  assert.equal(retained.ok, true);

  world.providerCalls.length = 0;
  now = 1_101;
  await assertProviderSessionNotOwned(world, {
    tenantId: 'tenant-a',
    runId: 'run-a',
    providerSessionId: 'session-tenant-a',
  });
  assert.deepEqual(world.providerCalls, []);
});

test('artifacts refuses an expired provider session after retention before lazy cleanup', async () => {
  let now = 1_000;
  const world = createWorld({
    now: () => now,
    defaultLeaseTtlMs: 100,
    minLeaseTtlMs: 1,
    maxLeaseTtlMs: 100,
    providerSessionRetentionMs: 50,
  });
  const lease = await allocateLease(world, 'tenant-a', 'run-a');

  now = lease.expiresAt + 51;
  await assertProviderSessionNotOwned(world, {
    tenantId: 'tenant-a',
    runId: 'run-a',
    providerSessionId: 'session-tenant-a',
  });
  assert.deepEqual(world.providerCalls, []);
});

test('artifacts refuses a provider session returned after allocation expiry retention', async () => {
  const clockValues = [1_000, 1_000, 1_099, 1_151] as const;
  let clockIndex = 0;
  const world = createWorld({
    now: () => clockValues[Math.min(clockIndex++, clockValues.length - 1)] ?? 1_151,
    defaultLeaseTtlMs: 100,
    minLeaseTtlMs: 1,
    maxLeaseTtlMs: 100,
    providerSessionRetentionMs: 50,
  });
  world.lifecycle.allocate = async () => ({ providerSessionId: 'late-allocation-session' });

  await allocateLease(world, 'tenant-a', 'run-a');
  await assertProviderSessionNotOwned(world, {
    tenantId: 'tenant-a',
    runId: 'run-a',
    providerSessionId: 'late-allocation-session',
  });
  assert.deepEqual(world.providerCalls, []);
});

test('artifacts refuses a provider session returned after release expiry retention', async () => {
  let now = 1_000;
  const world = createWorld({
    now: () => now,
    defaultLeaseTtlMs: 100,
    minLeaseTtlMs: 1,
    maxLeaseTtlMs: 100,
    providerSessionRetentionMs: 50,
  });
  const lease = await allocateLease(world, 'tenant-a', 'run-a');
  world.lifecycle.release = async (releasedLease) => {
    now = releasedLease.expiresAt + 51;
    return { providerSessionId: 'late-release-session' };
  };

  await releaseLease(world, lease);
  await assertProviderSessionNotOwned(world, {
    tenantId: 'tenant-a',
    runId: 'run-a',
    providerSessionId: 'late-release-session',
  });
  assert.deepEqual(world.providerCalls, []);
});

type World = {
  leaseRegistry: LeaseRegistry;
  sessionStore: ReturnType<typeof makeSessionStore>;
  providerCalls: CloudArtifactsQuery[];
  lifecycle: {
    allocate: (lease: DeviceLease) => Promise<Record<string, unknown>>;
    release: (lease: DeviceLease) => Promise<Record<string, unknown>>;
  };
};

function createWorld(
  options: {
    now?: () => number;
    defaultLeaseTtlMs?: number;
    minLeaseTtlMs?: number;
    maxLeaseTtlMs?: number;
    providerSessionRetentionMs?: number;
  } = {},
): World {
  const sessionStore = makeSessionStore('agent-device-lease-artifact-ownership-');
  const providerCalls: CloudArtifactsQuery[] = [];
  return {
    leaseRegistry: new LeaseRegistry(options),
    sessionStore,
    providerCalls,
    lifecycle: {
      allocate: async (lease) => ({ providerSessionId: `session-${lease.tenantId}` }),
      release: async (lease) => ({ providerSessionId: `session-${lease.tenantId}` }),
    },
  };
}

async function allocateLease(world: World, tenantId: string, runId: string): Promise<DeviceLease> {
  const response = await handleLeaseCommands({
    req: leaseRequest('lease_allocate', {
      tenantId,
      runId,
      leaseBackend: 'android-instance',
      leaseProvider: CLOUD_PROVIDER,
    }),
    sessionName: 'artifact-test',
    sessionStore: world.sessionStore,
    leaseRegistry: world.leaseRegistry,
    leaseLifecycleProvider: world.lifecycle,
  });
  assert.equal(response?.ok, true);
  if (!response?.ok) throw new Error('lease allocation failed');
  return response.data?.lease as DeviceLease;
}

async function releaseLease(world: World, lease: DeviceLease): Promise<void> {
  const response = await handleLeaseCommands({
    req: leaseRequest('lease_release', {
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseId: lease.leaseId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
    }),
    sessionName: 'artifact-test',
    sessionStore: world.sessionStore,
    leaseRegistry: world.leaseRegistry,
    leaseLifecycleProvider: world.lifecycle,
  });
  assert.equal(response?.ok, true);
}

async function listArtifacts(
  world: World,
  scope: {
    tenantId: string;
    runId: string;
    providerSessionId: string;
    leaseProvider?: string;
  },
): Promise<DaemonResponse> {
  return (await handleLeaseCommands({
    req: leaseRequest(
      'artifacts',
      {
        tenantId: scope.tenantId,
        runId: scope.runId,
        leaseProvider: scope.leaseProvider ?? CLOUD_PROVIDER,
      },
      { providerSessionId: scope.providerSessionId },
    ),
    sessionName: 'artifact-test',
    sessionStore: world.sessionStore,
    leaseRegistry: world.leaseRegistry,
    cloudArtifactProvider: {
      listCloudArtifacts: async (query) => {
        world.providerCalls.push({ ...query });
        return {
          provider: CLOUD_PROVIDER,
          status: 'ready',
          providerSessionId: query.providerSessionId,
          cloudArtifacts: [],
        };
      },
    },
  })) as DaemonResponse;
}

async function assertProviderSessionNotOwned(
  world: World,
  scope: {
    tenantId: string;
    runId: string;
    providerSessionId: string;
    leaseProvider?: string;
  },
): Promise<void> {
  await assert.rejects(
    () => listArtifacts(world, scope),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNAUTHORIZED');
      assert.equal(error.details?.reason, 'PROVIDER_SESSION_NOT_OWNED');
      return true;
    },
  );
}

function leaseRequest(
  command: string,
  meta: NonNullable<DaemonRequest['meta']>,
  flags: Record<string, unknown> = {},
): DaemonRequest {
  return {
    command,
    token: 'test-token',
    session: 'artifact-test',
    meta,
    flags,
    positionals: [],
  };
}
