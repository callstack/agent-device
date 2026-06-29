import assert from 'node:assert/strict';
import { test } from 'vitest';
import { withTargetDeviceResolutionScope } from '../../core/dispatch-resolve.ts';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { getDaemonCommandRoute, type DaemonCommandRoute } from '../daemon-command-registry.ts';
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
    PUBLIC_COMMANDS.gesture,
    PUBLIC_COMMANDS.home,
    PUBLIC_COMMANDS.installFromSource,
    PUBLIC_COMMANDS.rotate,
    PUBLIC_COMMANDS.screenshot,
    PUBLIC_COMMANDS.scroll,
    PUBLIC_COMMANDS.swipe,
    PUBLIC_COMMANDS.viewport,
  ].sort();
  const genericCatalogCommands = [
    ...Object.values(PUBLIC_COMMANDS),
    ...Object.values(INTERNAL_COMMANDS),
  ]
    .filter((command) => getDaemonCommandRoute(command) === 'generic')
    .sort();

  assert.deepEqual(genericCatalogCommands, intentionalGenericCatalogCommands);
  for (const command of ['fling', 'pan', 'pinch', 'rotate-gesture', 'transform-gesture']) {
    assert.equal(getDaemonCommandRoute(command), 'generic', `${command} passthrough route`);
  }
});

test('lease handler executes commands owned by the lease route', async () => {
  const leaseRegistry = new LeaseRegistry();
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
      leaseRegistry,
    });

    assert.notEqual(response, null, `${command} should be handled by lease handler`);
  }
});

test('lease handler preserves device-aware lease fields', async () => {
  const leaseRegistry = new LeaseRegistry();
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
    leaseRegistry,
  });

  assert.equal(heartbeatResponse?.ok, true);
  const heartbeatLease = readLeaseResponse(heartbeatResponse);
  assert.equal(heartbeatLease.deviceKey, 'device-1');
  assert.equal(heartbeatLease.clientId, 'client-a');
  assert.equal(heartbeatLease.leaseProvider, 'proxy');
});

test('lease release calls provider hook using the released lease without heartbeat mutation', async () => {
  const leaseRegistry = new LeaseRegistry();
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
