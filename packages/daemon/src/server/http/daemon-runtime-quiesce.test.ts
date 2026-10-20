import fs from 'node:fs';
import net from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  buildDaemonLifecycleRequest,
  resolveDaemonPaths,
  type DaemonRuntimeOwnership,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import * as shutdown from './server-shutdown.ts';

// A lifecycle request is the daemon's own answer to "may I leave?", so these tests boot the real
// runtime and ask over its real socket: the census, the closing of admission, the drain and the
// runtime close are one flow.
const probe = vi.hoisted(() => ({
  /** Holds daemon startup after its servers listen, until released. */
  startupGate: undefined as Promise<void> | undefined,
  store: undefined as import('../../core/session-store.ts').SessionStore | undefined,
  registry: undefined as import('../../resources/lease-registry.ts').LeaseRegistry | undefined,
  held: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
  diagnosticFailure: undefined as Error | undefined,
}));
vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return {
    ...actual,
    emitDiagnostic: (...args: Parameters<typeof actual.emitDiagnostic>) => {
      if (probe.diagnosticFailure) {
        if (args[0].phase === 'daemon_fatal') throw probe.diagnosticFailure;
        throw new Error('secondary diagnostic failure');
      }
      return actual.emitDiagnostic(...args);
    },
  };
});

vi.mock('@agent-device/daemon-contracts/device-claims', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/daemon-contracts/device-claims')>();
  return {
    ...actual,
    reconcileOrphanedDeviceClaims: async (
      ...args: Parameters<typeof actual.reconcileOrphanedDeviceClaims>
    ) => {
      await probe.startupGate;
      return await actual.reconcileOrphanedDeviceClaims(...args);
    },
  };
});
vi.mock('../../core/session-store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/session-store.ts')>();
  return {
    ...actual,
    SessionStore: class extends actual.SessionStore {
      constructor(...args: ConstructorParameters<typeof actual.SessionStore>) {
        super(...args);
        probe.store = this;
      }
    },
  };
});
vi.mock('../../resources/lease-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../resources/lease-registry.ts')>();
  class RecordedLeaseRegistry extends actual.LeaseRegistry {
    constructor(...args: ConstructorParameters<typeof actual.LeaseRegistry>) {
      super(...args);
      probe.registry = this;
    }
  }
  return { ...actual, LeaseRegistry: RecordedLeaseRegistry };
});
vi.mock('../request-router.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../request-router.ts')>();
  return {
    ...actual,
    createRequestHandler: (...args: Parameters<typeof actual.createRequestHandler>) => {
      const dispatch = actual.createRequestHandler(...args);
      return async (request: Parameters<typeof dispatch>[0]) => {
        if (probe.held) {
          probe.entered?.();
          await probe.held;
        }
        return await dispatch(request);
      };
    },
  };
});

import {
  applicationLifecycleResourceFixture,
  daemonRuntimeDepsFixture,
} from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { lifecycleDeviceRuntimeGateway } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { makeRepairArmedSession, makeSession } from '../../__tests__/support/session-factories.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

afterEach(() => {
  probe.startupGate = undefined;
  probe.held = undefined;
  probe.entered = undefined;
  probe.store = undefined;
  probe.registry = undefined;
  probe.diagnosticFailure = undefined;
  vi.restoreAllMocks();
});

type Booted = {
  runtime: NonNullable<Awaited<ReturnType<typeof startDaemonRuntime>>>;
  stateDir: string;
  exit: Promise<number>;
  quiesce(overrides?: LifecycleAddress): Promise<DaemonResponse>;
  sessionList(): Promise<DaemonResponse>;
};

type LifecycleAddress = {
  token?: string;
  pid?: number;
  processStartTime?: string | null;
  requestId?: string;
  /** Sends the request with no `meta` at all, the shape a caller that tracks no id produces. */
  omitMeta?: boolean;
};

async function bootDaemon(
  options: {
    serverMode?: 'socket' | 'dual';
    ownership?: DaemonRuntimeOwnership;
    idleTimeoutMs?: number;
    requestDrainMs?: number;
  } = {},
): Promise<Booted> {
  const stateDir = mkdtempForTestSync('agent-device-daemon-lifecycle-');
  const paths = resolveDaemonPaths(stateDir);
  const runtime = await startDaemonRuntime({
    composeDeps: daemonRuntimeDepsFixture(),
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: options.serverMode ?? 'socket',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: String(options.idleTimeoutMs ?? 0),
      },
    }),
    ownership: options.ownership,
    shutdownBudgets:
      options.requestDrainMs === undefined ? undefined : { requestDrainMs: options.requestDrainMs },
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
  if (!runtime?.socketPort) throw new Error('daemon did not start');
  const exit = runtime.closed.then(() => 0);
  const info = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as {
    pid: number;
    processStartTime?: string;
  };
  const socketPort = runtime.socketPort;
  const send = (request: object) => sendSocketRequest(socketPort, request);
  const sendLifecycle = (overrides: LifecycleAddress) => {
    const request = buildDaemonLifecycleRequest({
      token: overrides.token ?? runtime.token,
      fence: {
        pid: overrides.pid ?? info.pid,
        processStartTime:
          overrides.processStartTime !== undefined
            ? overrides.processStartTime
            : (info.processStartTime ?? null),
      },
      requestId: overrides.requestId ?? 'quiesce-test',
    });
    return overrides.omitMeta ? send({ ...request, meta: undefined }) : send(request);
  };
  return {
    runtime,
    stateDir,
    exit,
    quiesce: (overrides = {}) => sendLifecycle(overrides),
    sessionList: () =>
      send({
        token: runtime.token,
        session: 'default',
        command: 'session_list',
        positionals: [],
        meta: { requestId: 'session-list-test' },
      }),
  };
}

async function sendSocketRequest(port: number, request: object): Promise<DaemonResponse> {
  return await new Promise<DaemonResponse>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      socket.end();
      resolve(JSON.parse(buffer) as DaemonResponse);
    });
    socket.on('error', reject);
  });
}

function reasonOf(response: DaemonResponse): unknown {
  return response.ok ? undefined : response.error.details?.reason;
}

test('an idle daemon accepts a quiesce, drains and releases its state directory', async () => {
  const daemon = await bootDaemon();
  const paths = resolveDaemonPaths(daemon.stateDir);
  const published = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as {
    capabilities?: unknown;
  };
  expect(published.capabilities).toEqual(['quiesce']);

  expect(await daemon.quiesce()).toEqual({ ok: true, data: { outcome: 'draining' } });

  expect(await daemon.exit).toBe(0);
  expect(fs.existsSync(paths.infoPath)).toBe(false);
  expect(fs.existsSync(paths.lockPath)).toBe(false);
});

test('a daemon with a request in flight refuses to quiesce and keeps serving', async () => {
  const daemon = await bootDaemon();
  let release: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    probe.entered = resolve;
  });
  probe.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = daemon.sessionList();
  await entered;

  try {
    const refusal = await daemon.quiesce();
    expect(refusal.ok).toBe(false);
    expect(reasonOf(refusal)).toBe('daemon-busy');
    expect(!refusal.ok && refusal.error.details).toMatchObject({ inFlightRequests: 1 });

    release();
    expect((await running).ok).toBe(true);
    // Admission reopened with the refusal: the daemon still serves and can still be quiesced once idle.
    probe.held = undefined;
    expect((await daemon.sessionList()).ok).toBe(true);
    expect((await daemon.quiesce()).ok).toBe(true);
    await daemon.exit;
  } finally {
    release();
    await running.catch(() => {});
    await daemon.runtime.close();
  }
});

test('a daemon holding a session, a repair session or a live lease refuses to quiesce', async () => {
  const daemon = await bootDaemon();
  try {
    const openRef = probe.store!.publish('open-session', makeSession('open-session'));
    const withSession = await daemon.quiesce();
    expect(reasonOf(withSession)).toBe('daemon-busy');
    expect(!withSession.ok && withSession.error.details).toMatchObject({
      sessions: 1,
      repairSessions: 0,
    });
    probe.store!.retire(openRef);

    const repairRef = probe.store!.publish('repairing', makeRepairArmedSession('repairing'));
    const withRepair = await daemon.quiesce();
    expect(!withRepair.ok && withRepair.error.details).toMatchObject({
      sessions: 0,
      repairSessions: 1,
    });
    probe.store!.retire(repairRef);

    const lease = probe.registry!.allocateLease({
      tenantId: 'tenant-a',
      runId: 'run-a',
      ttlMs: 60_000,
    });
    const withLease = await daemon.quiesce();
    expect(!withLease.ok && withLease.error.details).toMatchObject({ leases: 1 });
    probe.registry!.releaseLease({ leaseId: lease.leaseId });

    expect((await daemon.quiesce()).ok).toBe(true);
    expect(await daemon.exit).toBe(0);
  } finally {
    await daemon.runtime.close();
  }
});

test('a quiesce with the wrong token or for another daemon instance leaves the daemon running', async () => {
  const daemon = await bootDaemon();
  try {
    const wrongToken = await daemon.quiesce({ token: 'not-the-token' });
    expect(!wrongToken.ok && wrongToken.error.code).toBe('UNAUTHORIZED');

    const otherInstance = await daemon.quiesce({ pid: readCurrentOwnerIdentity().pid + 1 });
    expect(reasonOf(otherInstance)).toBe('daemon-instance-mismatch');
    // A recycled pid is a different instance: the start time is part of the fence.
    const recycledPid = await daemon.quiesce({ processStartTime: 'a different start time' });
    expect(reasonOf(recycledPid)).toBe('daemon-instance-mismatch');

    expect((await daemon.sessionList()).ok).toBe(true);
  } finally {
    await daemon.runtime.close();
  }
});

async function quiesceOverHttp(
  daemon: Booted,
  headers: Record<string, string>,
): Promise<{ result?: DaemonResponse; error?: { data?: { code?: string } } }> {
  const { httpPort, token } = daemon.runtime;
  const info = JSON.parse(
    fs.readFileSync(resolveDaemonPaths(daemon.stateDir).infoPath, 'utf8'),
  ) as { pid: number; processStartTime?: string };
  const response = await fetch(`http://127.0.0.1:${httpPort}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'http-quiesce',
      method: 'agent_device.command',
      params: buildDaemonLifecycleRequest({
        token,
        fence: { pid: info.pid, processStartTime: info.processStartTime ?? null },
        requestId: 'http-quiesce',
      }),
    }),
  });
  return (await response.json()) as never;
}

test('a quiesce that arrives as a remote-origin HTTP request is refused', async () => {
  const daemon = await bootDaemon({ serverMode: 'dual' });
  try {
    const body = await quiesceOverHttp(daemon, { 'x-agent-device-network-access': 'public-only' });
    expect(JSON.stringify(body)).toContain('"UNAUTHORIZED"');
    expect((await daemon.sessionList()).ok).toBe(true);
  } finally {
    await daemon.runtime.close();
  }
});

test('a local HTTP quiesce drains an idle daemon like a socket one', async () => {
  const daemon = await bootDaemon({ serverMode: 'dual' });
  const body = await quiesceOverHttp(daemon, {});
  expect(body.result).toEqual({ ok: true, data: { outcome: 'draining' } });
  expect(await daemon.exit).toBe(0);
});

test('a host close retains registration and lock while a request ignores cancellation', async () => {
  const daemon = await bootDaemon({ ownership: 'embedded', requestDrainMs: 50 });
  const paths = resolveDaemonPaths(daemon.stateDir);
  let release: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    probe.entered = resolve;
  });
  probe.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  daemon.sessionList().catch(() => undefined);
  await entered;

  try {
    const report = await daemon.runtime.close();
    expect(report.requests.abandoned).toBe(1);
    expect(fs.existsSync(paths.lockPath)).toBe(true);
    expect(fs.existsSync(paths.infoPath)).toBe(true);
  } finally {
    release();
  }
});

test('a diagnostic failure starts listener close, retains unproved work and preserves the primary error', async () => {
  const daemon = await bootDaemon({ ownership: 'embedded' });
  const paths = resolveDaemonPaths(daemon.stateDir);
  const listeners = vi.spyOn(shutdown, 'closeDaemonServers');
  const primary = new Error('fatal diagnostic failed');
  probe.diagnosticFailure = primary;
  const exited = expect(daemon.exit).rejects.toBe(primary);
  await expect(daemon.runtime.close({ cause: new Error('shutdown cause') })).rejects.toBe(primary);
  await exited;
  expect(listeners).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(paths.infoPath)).toBe(true);
  expect(fs.existsSync(paths.lockPath)).toBe(true);
});

test('a rejected platform close retains registration and lock', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-lifecycle-close-failure-');
  const paths = resolveDaemonPaths(stateDir);
  const runtime = await startDaemonRuntime({
    composeDeps: daemonRuntimeDepsFixture(() => ({
      deviceRuntimeGateway: {
        ...lifecycleDeviceRuntimeGateway,
        applicationLifecycle: applicationLifecycleResourceFixture(),
        shutdown: async () => {
          throw new Error('gateway teardown rejected');
        },
      },
    })),
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'socket',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      },
    }),
    ownership: 'embedded',
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
  await expect(runtime.close()).rejects.toThrow('gateway teardown rejected');
  expect(fs.existsSync(paths.infoPath)).toBe(true);
  expect(fs.existsSync(paths.lockPath)).toBe(true);
});

test('an embedded runtime outlives the idle window a detached daemon reaps itself on', async () => {
  // Booted first on purpose: both get the same window, so the embedded one's window ends no later than
  // the detached one's. Booting it second would let this assertion run while its own window still had
  // time left, which would prove nothing about the rule.
  const embedded = await bootDaemon({ ownership: 'embedded', idleTimeoutMs: 40 });
  const detached = await bootDaemon({ idleTimeoutMs: 40 });
  const detachedPaths = resolveDaemonPaths(detached.stateDir);
  try {
    // Idle reap releases the state directory it reaped, so that is the fact to wait for. By then the
    // embedded runtime has been idle at least as long, so a window that ended one daemon's life is
    // proof enough that it did not end the other's.
    await vi.waitFor(() => expect(fs.existsSync(detachedPaths.infoPath)).toBe(false), {
      timeout: 5_000,
    });
    // A gap between requests is not the owner asking to be shut down.
    expect((await embedded.sessionList()).ok).toBe(true);
  } finally {
    await detached.runtime.close();
    await embedded.runtime.close();
  }
});

test('an embedded runtime refuses a quiesce, because its host decides when it leaves', async () => {
  const daemon = await bootDaemon({ ownership: 'embedded' });
  expect(reasonOf(await daemon.quiesce())).toBe('daemon-owner-embedded');
  // Nothing was closed and no admission was left closed: the host's runtime still serves.
  expect((await daemon.sessionList()).ok).toBe(true);
  await daemon.runtime.close();
  expect(await daemon.exit).toBe(0);
});

test('a quiesce asked while the daemon is still starting up is refused as busy, then accepted', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-lifecycle-startup-');
  const paths = resolveDaemonPaths(stateDir);
  let openGate: () => void = () => {};
  probe.startupGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const starting = startDaemonRuntime({
    composeDeps: daemonRuntimeDepsFixture(),
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'socket',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      },
    }),
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
  try {
    // Published, listening, and still held inside startup.
    for (let polls = 0; !fs.existsSync(paths.infoPath); polls += 1) {
      if (polls >= 500) throw new Error('daemon did not publish daemon.json during startup');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const info = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as {
      port: number;
      token: string;
      pid: number;
      processStartTime?: string;
    };

    const quiesceRequest = buildDaemonLifecycleRequest({
      token: info.token,
      fence: { pid: info.pid, processStartTime: info.processStartTime ?? null },
      requestId: 'startup-quiesce',
    });
    const response = await sendSocketRequest(info.port, quiesceRequest);
    // The daemon is still starting up, so it refuses as busy instead of promising a drain it cannot run yet.
    expect(response.ok).toBe(false);
    expect(reasonOf(response)).toBe('daemon-busy');
    expect(!response.ok && response.error.details).toMatchObject({
      startingUp: true,
      inFlightRequests: 0,
    });

    openGate();
    const runtime = await starting;
    const exit = runtime.closed.then(() => 0);
    const again = await sendSocketRequest(info.port, quiesceRequest);
    expect(again).toEqual({ ok: true, data: { outcome: 'draining' } });
    expect(await exit).toBe(0);
    expect(fs.existsSync(paths.infoPath)).toBe(false);
  } finally {
    openGate();
    await starting.then((runtime) => runtime?.close());
  }
});
