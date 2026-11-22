import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  IOS_SIMULATOR,
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
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
import { makeTestScreenRecordingResource } from '../../__tests__/support/screen-recording-live-handle.ts';
import { tenantScopedSessionName } from '../../core/session-tenant-scope.ts';
import type { SessionRef } from '../../core/session-state.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  createLeaseSessionEnd,
  getLeaseRegistryExecutionLocks,
  type LeaseSessionEnd,
} from '../request-execution-scope.ts';

const TENANT = 'e2b';
const SESSION = 'agentA';
const LEASE_TTL_MS = 60_000;
const OWNER_SCOPE = {
  tenantId: TENANT,
  runId: 'run-a',
  leaseProvider: 'proxy',
  clientId: 'client-a',
  deviceKey: 'ios:mobile:SIM-001',
} as const;

type RpcBody = {
  result?: { ok?: boolean; data?: Record<string, unknown> };
  error?: {
    message?: string;
    data?: { code?: string; details?: { reason?: string; field?: string } };
  };
};

let world: Awaited<ReturnType<typeof startDaemon>> | undefined;

beforeEach(async (context) => {
  if (await skipWhenLoopbackUnavailable(context)) return;
  world = await startDaemon();
});

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function startDaemon() {
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
  const publishLeasedSession = (address: string): SessionRef => {
    const session = makeIosAppSession(address, {
      sessionScope: { kind: 'tenant', id: TENANT },
      lease: {
        leaseId: lease.leaseId,
        tenantId: TENANT,
        runId: OWNER_SCOPE.runId,
        leaseBackend: lease.backend,
        leaseProvider: OWNER_SCOPE.leaseProvider,
        clientId: OWNER_SCOPE.clientId,
        deviceKey: OWNER_SCOPE.deviceKey,
      },
    });
    return sessionStore.publish(address, session);
  };
  const observeRunnerSession = vi.fn(async () => ({ alive: true, sessionId: 'runner-1' }));
  const hostDiagnostics = hostDiagnosticsFixture();
  // A request that ends an expired session itself stops the snapshot helper of that session.
  const requestTeardown = platformResourceCleanupFixture();
  const runtime = createLifecycleDeviceRuntimeGatewaySpies();
  const hooks: { beforeDispatch?: () => void; duringDeviceSelection?: () => void } = {};
  const handleRequest = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('agent-device-session-lease-touch-log-'), 'daemon.log'),
    token: 'daemon-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => {
        hooks.duringDeviceSelection?.();
        return [IOS_SIMULATOR];
      },
    }),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact: () => 'artifact-id',
    hostDiagnostics,
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
      hooks.beforeDispatch?.();
      return await task();
    },
  });
  const daemon = await createDaemonHttpServer({
    token: 'daemon-token',
    handleRequest,
    env: {},
    cwd: process.cwd(),
  });
  const daemonPort = await listenOnLoopback(daemon);
  const send = async (
    command: string,
    positionals: string[],
    meta: Record<string, unknown>,
    request: { session?: string; flags?: Record<string, unknown> } = {},
  ) => {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/rpc`, {
      method: 'POST',
      headers: { authorization: 'Bearer daemon-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: command,
        method: 'agent_device.command',
        params: {
          session: request.session ?? SESSION,
          command,
          positionals,
          flags: request.flags ?? {},
          meta: { tenantId: TENANT, sessionIsolation: 'tenant', sessionExplicit: true, ...meta },
        },
      }),
    });
    return (await response.json()) as RpcBody;
  };
  return {
    owner: { ...OWNER_SCOPE, leaseBackend: lease.backend, leaseId: lease.leaseId },
    /** Another client of the same proxy token and tenant, with a live lease of its own. */
    allocateOtherClient: (deviceKey: string = OWNER_SCOPE.deviceKey) => {
      const scope = {
        ...OWNER_SCOPE,
        runId: 'run-b',
        clientId: 'client-b',
        deviceKey,
        leaseBackend: 'ios-instance',
      } as const;
      const { leaseId } = leaseRegistry.allocateLease({ ...scope, ttlMs: 10 * LEASE_TTL_MS });
      return { ...scope, leaseId };
    },
    leaseId: lease.leaseId,
    sessionName,
    sessionStore,
    leaseRegistry,
    publishLeasedSession,
    expiryTeardown,
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
    requestEvents: async (address: string) => {
      await sessionStore.flushEvents(address);
      return sessionStore
        .readEvents(address)
        .events.map((event) => event.kind)
        .filter((kind) => kind.startsWith('request.'));
    },
    close: async () => {
      await closeLoopbackServer(daemon);
    },
  };
}

function expectLeaseIdRefusal(body: RpcBody): void {
  expect(body.error?.data, JSON.stringify(body)).toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'LEASE_SESSION_MISMATCH', field: 'leaseId' },
  });
}

test('a refused request writes no event into the leased session, and the owner request does', async () => {
  if (!world) return;
  world.publishLeasedSession(world.sessionName);

  expectLeaseIdRefusal(await world.send('snapshot', [], {}));
  expect(await world.requestEvents(world.sessionName)).toEqual([]);

  const snapshot = await world.send('snapshot', [], world.owner);
  expect(snapshot.result?.ok, JSON.stringify(snapshot)).toBe(true);
  expect(await world.requestEvents(world.sessionName)).toEqual([
    'request.started',
    'request.finished',
  ]);
});

test.each([
  ['no lease id', {}],
  ['a lease id that is not active', { leaseId: 'f'.repeat(32) }],
])('a close with %s does not end an expired leased session', async (_name, scope) => {
  if (!world) return;
  const ref = world.publishLeasedSession(world.sessionName);
  world.passLeaseDeadline();

  const closed = await world.send('close', [], scope);

  expect(closed.error?.data, JSON.stringify(closed)).toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'LEASE_SESSION_MISMATCH' },
  });
  expect(JSON.stringify(closed)).not.toContain(world.leaseId);
  expect(JSON.stringify(closed)).not.toContain('endedLeases');
  expect(world.sessionStore.lookup(world.sessionName)?.lifetime).toBe(ref.lifetime);
  expect(world.expiryTeardown).not.toHaveBeenCalled();
  expect(world.requestTeardown.stopSnapshotHelper).not.toHaveBeenCalled();
  expect(world.runtime.inspectFacts).not.toHaveBeenCalled();
  expect(await world.requestEvents(world.sessionName)).toEqual([]);
});

test('a new owner opens the session right after the lease deadline, before the sweep', async () => {
  if (!world) return;
  world.publishLeasedSession(world.sessionName);
  // Allocated before the deadline, so no registry call has noticed the expiry yet.
  const successor = world.allocateOtherClient('ios:mobile:SIM-002');
  world.passLeaseDeadline();

  const opened = await world.send('open', ['com.example.app'], successor);

  expect(opened.result?.ok, JSON.stringify(opened)).toBe(true);
  expect(world.sessionStore.get(world.sessionName)?.lease?.leaseId).toBe(successor.leaseId);
  expect(JSON.stringify(opened)).not.toContain(world.leaseId);
  expect(JSON.stringify(opened)).not.toContain('endedLeases');
  expect(await world.requestEvents(world.sessionName)).toEqual([
    'request.started',
    'request.finished',
  ]);
  // The open ended the expired session under its own locks, so the lease-end owner found none.
  expect(world.requestTeardown.stopSnapshotHelper).toHaveBeenCalledTimes(1);
  await world.expiryOwnerSettled();
  expect(world.expiryTeardown).not.toHaveBeenCalled();
});

test('doctor with the lease id after the deadline leaves the session to the lease-end owner', async () => {
  if (!world) return;
  const ref = world.publishLeasedSession(world.sessionName);
  world.passLeaseDeadline();

  await world.send('doctor', [], world.owner);

  expect(world.requestTeardown.stopSnapshotHelper).not.toHaveBeenCalled();
  await world.expiryOwnerSettled();
  expect(world.expiryTeardown).toHaveBeenCalledTimes(1);
  expect(world.expiryTeardown.mock.calls[0]?.[0].lifetime).toBe(ref.lifetime);
});

test('the owner request after the deadline ends its own expired session', async () => {
  if (!world) return;
  world.publishLeasedSession(world.sessionName);
  world.passLeaseDeadline();

  const snapshot = await world.send('snapshot', [], world.owner);

  expect(snapshot.error?.data?.code, JSON.stringify(snapshot)).toBe('UNAUTHORIZED');
  expect(snapshot.error?.data?.details?.reason).not.toBe('LEASE_SESSION_MISMATCH');
  expect(world.sessionStore.get(world.sessionName)).toBeUndefined();
});

test('devices with no lease id stays detached from a leased session and its recording', async () => {
  if (!world) return;
  const { session } = world.publishLeasedSession(world.sessionName);
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'runner AVAssetWriter',
    runnerSessionId: 'runner-0',
  });

  const devices = await world.send('devices', [], {});

  expect(devices.result?.ok, JSON.stringify(devices)).toBe(true);
  expect(world.observeRunnerSession).not.toHaveBeenCalled();
  expect(session.screenRecording.handle.inspect().invalidatedReason).toBeUndefined();
  expect(await world.requestEvents(world.sessionName)).toEqual([]);

  // The owner's command still checks the recording: the runner restarted, so it is refused.
  const snapshot = await world.send('snapshot', [], world.owner);
  expect(world.observeRunnerSession).toHaveBeenCalledTimes(1);
  expect(snapshot.error?.message, JSON.stringify(snapshot)).toBe(
    'iOS runner session restarted during recording',
  );
});

test.each(['doctor', 'events'])(
  '%s with no lease id returns nothing from a leased session opened after its admission',
  async (command) => {
    if (!world) return;
    const { hooks, publishLeasedSession, sessionName } = world;
    hooks.beforeDispatch = () => {
      publishLeasedSession(sessionName);
    };

    expectLeaseIdRefusal(await world.send(command, [], {}));

    expect(world.hostDiagnostics.deviceChecks).not.toHaveBeenCalled();
    expect(world.runtime.inspectFacts).not.toHaveBeenCalled();
  },
);

test('capabilities with no lease id reads nothing from a leased session opened during its device selection', async () => {
  if (!world) return;
  const { hooks, publishLeasedSession, sessionName } = world;
  hooks.duringDeviceSelection = () => {
    publishLeasedSession(sessionName);
  };
  // The runtime cannot read the foreground app here, so only a session app would list `appstate`.
  const inspectFacts = world.runtime.inspectFacts.getMockImplementation()!;
  world.runtime.inspectFacts.mockImplementation(async (device) => {
    const facts = await inspectFacts(device);
    const unavailable = { available: false, reason: 'unsupported-device-kind' } as const;
    return {
      ...facts,
      operations: { ...facts.operations, ensureReady: { available: true }, appState: unavailable },
    };
  });

  const capabilities = await world.send('capabilities', [], {}, { flags: { platform: 'ios' } });

  expect(capabilities.result?.ok, JSON.stringify(capabilities)).toBe(true);
  expect(world.sessionStore.get(sessionName)).toBeDefined();
  // `appstate` is available only through the app of the session.
  expect(JSON.stringify(capabilities.result?.data)).not.toContain('appstate');
});

test('doctor with the lease id reports its leased session', async () => {
  if (!world) return;
  world.publishLeasedSession(world.sessionName);

  const doctor = await world.send('doctor', [], world.owner);

  expect(doctor.result?.ok, JSON.stringify(doctor)).toBe(true);
  expect(JSON.stringify(doctor.result?.data)).toContain(world.sessionName);
  expect(world.hostDiagnostics.deviceChecks).toHaveBeenCalledTimes(1);
});

function writeSuite(): { flags: Record<string, unknown>; positionals: string[] } {
  const root = mkdtempForTestSync('agent-device-session-lease-touch-suite-');
  const scriptPath = path.join(root, 'flow.ad');
  const script = 'context platform=ios\nwait 0\n';
  fs.writeFileSync(scriptPath, script);
  return {
    positionals: [scriptPath],
    flags: {
      recordVideo: true,
      replayScriptSources: [{ entry: scriptPath, files: { [scriptPath]: script } }],
    },
  };
}

// A direct RPC caller chooses the suite session and request id, and so the attempt address.
const SUITE_SESSION = 'suite';
const SUITE_REQUEST_ID = 'chosen';
const attemptAddress = (): string =>
  `${tenantScopedSessionName(TENANT, SUITE_SESSION)}:test:${SUITE_REQUEST_ID}:1-flow:attempt-1`;

test('a test suite of another client neither records nor closes a leased session at its attempt address', async () => {
  if (!world) return;
  const ref = world.publishLeasedSession(attemptAddress());
  const suite = writeSuite();

  const response = await world.send(
    'test',
    suite.positionals,
    { ...world.allocateOtherClient('ios:mobile:SIM-002'), requestId: SUITE_REQUEST_ID },
    { session: SUITE_SESSION, flags: suite.flags },
  );

  expect(JSON.stringify(response)).toContain('LEASE_SESSION_MISMATCH');
  const attempt = world.sessionStore.lookup(attemptAddress());
  expect(attempt?.lifetime).toBe(ref.lifetime);
  expect(attempt?.session.screenRecording).toBeUndefined();
  expect(world.runtime.bind).not.toHaveBeenCalled();
});

test('a test suite with the lease id runs on and closes its leased attempt session', async () => {
  if (!world) return;
  world.publishLeasedSession(attemptAddress());
  const suite = writeSuite();

  const response = await world.send(
    'test',
    suite.positionals,
    { ...world.owner, requestId: SUITE_REQUEST_ID },
    { session: SUITE_SESSION, flags: { ...suite.flags, recordVideo: false } },
  );

  expect(response.result?.data, JSON.stringify(response)).toMatchObject({ passed: 1, failed: 0 });
  expect(world.sessionStore.get(attemptAddress())).toBeUndefined();
});
