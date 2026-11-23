import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { createLeaseSessionEnd, type LeaseSessionEnd } from '../lease-session-end.ts';
import path from 'node:path';
import { vi } from 'vitest';
import {
  IOS_SIMULATOR,
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { type DaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';
import { createDaemonHttpServer } from './http-server.ts';
import {
  createLifecycleDeviceRuntimeGatewaySpies,
  createRequestHandler,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { makeIosAppSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { hostDiagnosticsFixture } from '../../__tests__/support/host-diagnostics-fixture.ts';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { tenantScopedSessionName } from '../../core/session-tenant-scope.ts';
import type { SessionRef } from '../../core/session-state.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { getLeaseRegistryExecutionLocks } from '../request-execution-scope.ts';

export const TENANT = 'e2b';
export const SESSION = 'agentA';
export const LEASE_TTL_MS = 60_000;
const OWNER_SCOPE = {
  tenantId: TENANT,
  runId: 'run-a',
  leaseProvider: 'proxy',
  clientId: 'client-a',
  deviceKey: 'ios:mobile:SIM-001',
} as const;

export type RpcBody = {
  result?: { ok?: boolean; data?: Record<string, unknown> };
  error?: {
    message?: string;
    data?: {
      code?: string;
      details?: { reason?: string; field?: string; endedLeases?: unknown[] };
    };
  };
};

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function startDaemon(daemonPolicy?: DaemonPolicy) {
  let now = 1_000;
  const sessionStore = makeSessionStore('agent-device-session-lease-touch-');
  const expiryTeardown = vi.fn(async (_ref: SessionRef) => {});
  const expiryEnds: Promise<void>[] = [];
  const leaseRegistry = new LeaseRegistry({
    now: () => now,
    // The expiry owner of a real daemon: it ends the sessions of an expired lease under their locks.
    onLeaseExpired: (lease) => {
      expiryEnds.push(leaseSessionEnd.end(lease.leaseId, 'LEASE_EXPIRED'));
    },
  });
  const leaseSessionEnd: LeaseSessionEnd = createLeaseSessionEnd({
    env: {},
    sessionStore,
    executionLocks: getLeaseRegistryExecutionLocks(leaseRegistry),
    teardownSession: expiryTeardown,
    cleanupSessionlessExecutionHost: async () => {},
  });
  const lease = leaseRegistry.allocateLease({
    ...OWNER_SCOPE,
    leaseBackend: 'ios-instance',
    ttlMs: LEASE_TTL_MS,
  });
  const sessionName = tenantScopedSessionName(TENANT, SESSION);
  const publishLeasedSession = (address: string, backend = lease.backend): SessionRef => {
    const session = makeIosAppSession(address, {
      sessionScope: { kind: 'tenant', id: TENANT },
      lease: {
        leaseId: lease.leaseId,
        tenantId: TENANT,
        runId: OWNER_SCOPE.runId,
        backend,
        leaseProvider: OWNER_SCOPE.leaseProvider,
        clientId: OWNER_SCOPE.clientId,
        deviceKey: OWNER_SCOPE.deviceKey,
      },
    });
    return sessionStore.publish(address, session);
  };
  const observeRunnerSession = vi.fn(async () => ({ alive: true, sessionId: 'runner-1' }));
  const hostDiagnostics = hostDiagnosticsFixture();
  const requestTeardown = platformResourceCleanupFixture();
  const runtime = createLifecycleDeviceRuntimeGatewaySpies();
  const hooks: {
    beforeDispatch?: () => void | Promise<void>;
    duringDeviceSelection?: () => void;
    afterRequest?: (response: DaemonResponse) => void;
  } = {};
  const settlementFor = vi.fn(leaseSessionEnd.settlementFor);
  const handleRequest = createRequestHandler({
    host: createTestHostEnvironment({
      env: { ...process.env, AGENT_DEVICE_MACOS_APP_BACKEND: 'native' },
    }),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('agent-device-session-lease-touch-log-'), 'daemon.log'),
    token: 'daemon-token',
    sessionStore,
    leaseRegistry,
    leaseSessionEnd: { settlementFor },
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => {
        hooks.duringDeviceSelection?.();
        return [IOS_SIMULATOR];
      },
    }),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact: () => 'artifact-id',
    hostDiagnostics,
    daemonPolicy,
    platformResourceCleanup: requestTeardown,
    platformServices: daemonPlatformServicesFixture({
      appleSessionObservation: {
        observeRunnerSession,
        resolveSoleForegroundApp: async () => undefined,
      },
    }),
    // Runs after admission and before the handler, where an owner's open can land for a command
    // that holds no session lock.
    providerDeviceRuntimeScope: async (task) => {
      await hooks.beforeDispatch?.();
      return await task();
    },
  });
  const daemon = await createDaemonHttpServer({
    token: 'daemon-token',
    handleRequest: async (req) => {
      const response = await handleRequest(req);
      hooks.afterRequest?.(response);
      return response;
    },
    env: {},
    cwd: process.cwd(),
  });
  const daemonPort = await listenOnLoopback(daemon);
  let requestNumber = 0;
  const send = async (
    command: string,
    positionals: string[],
    meta: Record<string, unknown>,
    request: { session?: string; flags?: Record<string, unknown>; signal?: AbortSignal } = {},
  ) => {
    const requestId = `lease-touch-${++requestNumber}`;
    const response = await fetch(`http://127.0.0.1:${daemonPort}/rpc`, {
      method: 'POST',
      signal: request.signal,
      headers: { authorization: 'Bearer daemon-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'agent_device.command',
        params: {
          session: request.session ?? SESSION,
          command,
          positionals,
          flags: request.flags ?? {},
          meta: {
            requestId,
            tenantId: TENANT,
            sessionIsolation: 'tenant',
            sessionExplicit: true,
            ...meta,
          },
        },
      }),
    });
    return (await response.json()) as RpcBody;
  };
  return {
    owner: { ...OWNER_SCOPE, leaseBackend: lease.backend, leaseId: lease.leaseId },
    /** Another client of the same proxy token and tenant, with a live lease of its own. */
    allocateOtherClient: (deviceKey: string = OWNER_SCOPE.deviceKey, ttlMs = 10 * LEASE_TTL_MS) => {
      const scope = {
        ...OWNER_SCOPE,
        runId: 'run-b',
        clientId: 'client-b',
        deviceKey,
        leaseBackend: 'ios-instance',
      } as const;
      const { leaseId } = leaseRegistry.allocateLease({ ...scope, ttlMs });
      return { ...scope, leaseId };
    },
    leaseId: lease.leaseId,
    sessionName,
    sessionStore,
    leaseRegistry,
    publishLeasedSession,
    expiryTeardown,
    settlementFor,
    observeRunnerSession,
    hostDiagnostics,
    requestTeardown,
    runtime,
    hooks,
    send,
    passLeaseDeadline: () => {
      now += LEASE_TTL_MS + 1;
    },
    expiryOwnerSettled: async () => {
      await Promise.all(expiryEnds);
    },
    requestEvents: async (address: string, command?: string) => {
      const ref = sessionStore.lookup(address);
      if (!ref) return [];
      await sessionStore.flushEvents(ref);
      return sessionStore
        .readEvents(ref)
        .events.filter(
          (event) =>
            event.kind.startsWith('request.') &&
            (command === undefined || event.command === command),
        )
        .map((event) => event.kind);
    },
    close: async () => {
      await closeLoopbackServer(daemon);
    },
  };
}
