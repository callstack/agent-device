import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { withTargetDeviceResolutionScope } from '../../core/dispatch-resolve.ts';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { getDaemonCommandRoute, type DaemonCommandRoute } from '../daemon-command-registry.ts';
import { cleanupDownloadableArtifact, trackDownloadableArtifact } from '../artifact-tracking.ts';
import { contextFromFlags } from '../context.ts';
import { handleLeaseCommands } from '../handlers/lease.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { runRequestHandlerChain } from '../request-handler-chain.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';

const SPECIALIZED_ROUTES = [
  'lease',
  'session',
  'snapshot',
  'reactNative',
  'recordTrace',
  'find',
  'interaction',
] as const satisfies readonly Exclude<DaemonCommandRoute, 'generic'>[];

const ROUTING_MISMATCH_MESSAGE = 'Daemon handler routing mismatch';

test('specialized daemon routes are claimed by their handler chain', async () => {
  for (const route of SPECIALIZED_ROUTES) {
    const commands = catalogCommandsForRoute(route);
    assert.ok(commands.length > 0, `${route} route should own at least one command`);
    for (const command of commands) {
      const response = await runCatalogCommandThroughHandlerChain(command);
      assert.notEqual(response, null, `${route} route should claim ${command}`);
    }
  }
});

test('catalog commands use generic routing only when intentionally passthrough or projected', () => {
  const intentionalGenericCatalogCommands = [
    PUBLIC_COMMANDS.appSwitcher,
    PUBLIC_COMMANDS.back,
    PUBLIC_COMMANDS.focus,
    PUBLIC_COMMANDS.home,
    PUBLIC_COMMANDS.installFromSource,
    PUBLIC_COMMANDS.rotate,
    PUBLIC_COMMANDS.screenshot,
    PUBLIC_COMMANDS.scroll,
    PUBLIC_COMMANDS.tvRemote,
    PUBLIC_COMMANDS.viewport,
  ].sort();
  const genericCatalogCommands = [
    ...Object.values(PUBLIC_COMMANDS),
    ...Object.values(INTERNAL_COMMANDS),
  ]
    .filter((command) => getDaemonCommandRoute(command) === 'generic')
    .sort();

  assert.deepEqual(genericCatalogCommands, intentionalGenericCatalogCommands);
});

test('lease handler executes commands owned by the lease route', async () => {
  const leaseRegistry = new LeaseRegistry();
  const sessionStore = makeSessionStore('agent-device-lease-route-');
  const allocated = leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-a' });

  const leaseCommands = [
    INTERNAL_COMMANDS.leaseAllocate,
    INTERNAL_COMMANDS.leaseHeartbeat,
    INTERNAL_COMMANDS.leaseRelease,
  ];

  for (const command of leaseCommands) {
    const response = await handleLeaseCommands({
      req: {
        command,
        token: 'test-token',
        session: 'catalog-test',
        flags: {
          tenant: 'tenant-a',
          runId: 'run-a',
          ...(command === INTERNAL_COMMANDS.leaseAllocate ? {} : { leaseId: allocated.leaseId }),
        },
        positionals: [],
      },
      sessionName: 'catalog-test',
      sessionStore,
      leaseRegistry,
    });

    assert.notEqual(response, null, `${command} should be handled by lease handler`);
  }
});

test('lease handler preserves device-aware lease fields', async () => {
  const leaseRegistry = new LeaseRegistry();
  const sessionStore = makeSessionStore('agent-device-lease-fields-');
  const allocateResponse = await handleLeaseCommands({
    req: {
      command: INTERNAL_COMMANDS.leaseAllocate,
      token: 'test-token',
      session: 'catalog-test',
      meta: {
        tenantId: 'tenant-a',
        runId: 'run-a',
        leaseBackend: 'ios-instance',
        leaseProvider: 'proxy',
        deviceKey: 'device-1',
        clientId: 'client-a',
      },
      positionals: [],
    },
    sessionName: 'catalog-test',
    sessionStore,
    leaseRegistry,
  });

  assert.equal(allocateResponse?.ok, true);
  const allocateLease = readLeaseResponse(allocateResponse);
  assert.equal(allocateLease.deviceKey, 'device-1');
  assert.equal(allocateLease.clientId, 'client-a');
  assert.equal(allocateLease.leaseProvider, 'proxy');

  const heartbeatResponse = await handleLeaseCommands({
    req: {
      command: INTERNAL_COMMANDS.leaseHeartbeat,
      token: 'test-token',
      session: 'catalog-test',
      meta: {
        tenantId: 'tenant-a',
        runId: 'run-a',
        leaseId: allocateLease.leaseId,
        leaseBackend: 'ios-instance',
        leaseProvider: 'proxy',
        deviceKey: 'device-1',
        clientId: 'client-a',
      },
      positionals: [],
    },
    sessionName: 'catalog-test',
    sessionStore,
    leaseRegistry,
  });

  assert.equal(heartbeatResponse?.ok, true);
  const heartbeatLease = readLeaseResponse(heartbeatResponse);
  assert.equal(heartbeatLease.deviceKey, 'device-1');
  assert.equal(heartbeatLease.clientId, 'client-a');
  assert.equal(heartbeatLease.leaseProvider, 'proxy');
});

test('lease artifacts lists daemon inventory for proxy lease scopes', async () => {
  const leaseRegistry = new LeaseRegistry();
  const sessionStore = makeSessionStore('agent-device-lease-artifacts-');
  const tracked = trackProxyLeaseArtifact();

  try {
    const response = await handleLeaseCommands({
      req: proxyArtifactsRequest(),
      sessionName: 'catalog-test',
      sessionStore,
      leaseRegistry,
    });

    assertProxyLeaseArtifactInventory(response, tracked.artifactId);
  } finally {
    cleanupDownloadableArtifact(tracked.artifactId);
    fs.rmSync(tracked.tempDir, { recursive: true, force: true });
  }
});

test('lease release calls provider hook using the released lease without heartbeat mutation', async () => {
  const leaseRegistry = new LeaseRegistry();
  const sessionStore = makeSessionStore('agent-device-lease-release-');
  const releaseCalls: string[] = [];
  const allocateResponse = await handleLeaseCommands({
    req: {
      command: INTERNAL_COMMANDS.leaseAllocate,
      token: 'test-token',
      session: 'catalog-test',
      meta: {
        tenantId: 'tenant-a',
        runId: 'run-a',
        leaseBackend: 'android-instance',
        leaseProvider: 'fake-provider',
        leaseTtlMs: 20_000,
      },
      positionals: [],
    },
    sessionName: 'catalog-test',
    sessionStore,
    leaseRegistry,
  });
  assert.equal(allocateResponse?.ok, true);
  const lease = readLeaseResponse(allocateResponse);

  const releaseResponse = await handleLeaseCommands({
    req: {
      command: INTERNAL_COMMANDS.leaseRelease,
      token: 'test-token',
      session: 'catalog-test',
      meta: {
        tenantId: 'tenant-a',
        runId: 'run-a',
        leaseId: lease.leaseId,
        leaseBackend: 'android-instance',
        leaseProvider: 'fake-provider',
        leaseTtlMs: 1,
      },
      positionals: [],
    },
    sessionName: 'catalog-test',
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider: {
      release: async (releasedLease) => {
        releaseCalls.push(releasedLease.leaseId);
        return { provider: releasedLease.leaseProvider };
      },
    },
  });

  assert.equal(releaseResponse?.ok, true);
  assert.deepEqual(releaseCalls, [lease.leaseId]);
  assert.deepEqual(releaseResponse.data, {
    released: true,
    provider: { provider: 'fake-provider' },
  });
});

function catalogCommandsForRoute(route: Exclude<DaemonCommandRoute, 'generic'>): string[] {
  return [...Object.values(PUBLIC_COMMANDS), ...Object.values(INTERNAL_COMMANDS)].filter(
    (command) => getDaemonCommandRoute(command) === route,
  );
}

async function runCatalogCommandThroughHandlerChain(
  command: string,
): Promise<DaemonResponse | null> {
  const sessionStore = makeSessionStore('agent-device-catalog-route-');
  const leaseRegistry = new LeaseRegistry();
  const req = catalogRouteRequest(command);

  try {
    return await withTargetDeviceResolutionScope(
      async () => [],
      async () =>
        await runRequestHandlerChain({
          req,
          sessionName: req.session,
          logPath: '/tmp/agent-device-catalog-route.log',
          sessionStore,
          leaseRegistry,
          invoke: async () => ({ ok: true, data: {} }),
          androidAdbExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          contextFromFlags: (flags, appBundleId, traceLogPath) =>
            contextFromFlags(
              '/tmp/agent-device-catalog-route.log',
              flags,
              appBundleId,
              traceLogPath,
            ),
        }),
    );
  } catch (error) {
    assertNoRoutingMismatch(error, command);
    return {
      ok: false,
      error: {
        code: 'ROUTE_CLAIMED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function catalogRouteRequest(command: string): DaemonRequest {
  return {
    command,
    token: 'test-token',
    session: 'catalog-test',
    flags: {
      tenant: 'tenant-a',
      runId: 'run-a',
      leaseId: '0'.repeat(32),
    },
    positionals: [],
  };
}

function trackProxyLeaseArtifact(): { artifactId: string; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-lease-artifacts-'));
  const artifactPath = path.join(tempDir, 'proxy-shot.png');
  fs.writeFileSync(artifactPath, 'png-body');
  return {
    tempDir,
    artifactId: trackDownloadableArtifact({
      artifactPath,
      artifactType: 'screenshot',
      fileName: 'proxy-shot.png',
      tenantId: 'tenant-a',
    }),
  };
}

function proxyArtifactsRequest(): DaemonRequest {
  return {
    command: PUBLIC_COMMANDS.artifacts,
    token: 'test-token',
    session: 'catalog-test',
    meta: {
      tenantId: 'tenant-a',
      runId: 'run-a',
      leaseId: 'lease-a',
      leaseProvider: 'proxy',
      deviceKey: 'device-1',
      clientId: 'client-a',
    },
    positionals: [],
  };
}

function assertProxyLeaseArtifactInventory(
  response: DaemonResponse | null,
  artifactId: string,
): void {
  assert.equal(response?.ok, true);
  const data = response.data as Record<string, unknown> | undefined;
  assert.equal(data?.source, 'daemon');
  const artifact = readSingleArtifactRecord(data?.artifacts);
  assert.deepEqual(
    {
      id: artifact.id,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
    },
    {
      id: artifactId,
      filename: 'proxy-shot.png',
      mimeType: 'application/octet-stream',
      sizeBytes: 'png-body'.length,
    },
  );
  assert.equal(typeof artifact.createdAt, 'string');
  assert.equal(typeof artifact.expiresAt, 'string');
}

function readSingleArtifactRecord(value: unknown): Record<string, unknown> {
  assert.ok(Array.isArray(value));
  assert.equal(value.length, 1);
  assert.ok(value[0] && typeof value[0] === 'object' && !Array.isArray(value[0]));
  return value[0] as Record<string, unknown>;
}

function assertNoRoutingMismatch(error: unknown, command: string): void {
  assert.ok(error instanceof Error, `${command} threw a non-error value`);
  assert.doesNotMatch(error.message, new RegExp(ROUTING_MISMATCH_MESSAGE), command);
}

function readLeaseResponse(response: DaemonResponse | null): Record<string, unknown> & {
  leaseId: string;
} {
  assert.ok(response?.ok);
  const lease = response.data?.lease;
  assert.ok(lease && typeof lease === 'object' && !Array.isArray(lease));
  assert.equal(typeof (lease as Record<string, unknown>).leaseId, 'string');
  return lease as Record<string, unknown> & { leaseId: string };
}
