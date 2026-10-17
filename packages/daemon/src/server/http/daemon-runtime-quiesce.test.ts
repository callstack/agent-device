import fs from 'node:fs';
import net from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  buildDaemonQuiesceRequest,
  resolveDaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import type { DaemonResponse } from '@agent-device/kernel/contracts';

// A quiesce is the daemon's own answer to "may I leave?", so these tests boot the real runtime and
// ask over its real socket: the census, the closing of admission and the drain are one flow.
const probe = vi.hoisted(() => ({
  /** Holds daemon startup after its servers listen, until released. */
  startupGate: undefined as Promise<void> | undefined,
  store: undefined as import('../../core/session-store.ts').SessionStore | undefined,
  registry: undefined as import('../../resources/lease-registry.ts').LeaseRegistry | undefined,
  held: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
}));

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

import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { makeRepairArmedSession, makeSession } from '../../__tests__/support/session-factories.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

afterEach(() => {
  probe.startupGate = undefined;
  probe.held = undefined;
  probe.entered = undefined;
  probe.store = undefined;
  probe.registry = undefined;
});

type Booted = {
  runtime: NonNullable<Awaited<ReturnType<typeof startDaemonRuntime>>>;
  stateDir: string;
  exit: Promise<number>;
  quiesce(overrides?: {
    token?: string;
    pid?: number;
    processStartTime?: string | null;
  }): Promise<DaemonResponse>;
  sessionList(): Promise<DaemonResponse>;
};

async function bootDaemon(options: { serverMode?: 'socket' | 'dual' } = {}): Promise<Booted> {
  const stateDir = mkdtempForTestSync('agent-device-daemon-quiesce-');
  const paths = resolveDaemonPaths(stateDir);
  let resolveExit: (code: number) => void = () => {};
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const runtime = await startDaemonRuntime({
    composeDeps: daemonRuntimeDepsFixture(),
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: options.serverMode ?? 'socket',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      },
    }),
    exit: resolveExit,
    registerProcessHandlers: false,
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
  if (!runtime?.socketPort) throw new Error('daemon did not start');
  const info = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as {
    pid: number;
    processStartTime?: string;
  };
  const socketPort = runtime.socketPort;
  const send = (request: object) => sendSocketRequest(socketPort, request);
  return {
    runtime,
    stateDir,
    exit,
    quiesce: (overrides = {}) =>
      send(
        buildDaemonQuiesceRequest({
          token: overrides.token ?? runtime.token,
          fence: {
            pid: overrides.pid ?? info.pid,
            processStartTime:
              overrides.processStartTime !== undefined
                ? overrides.processStartTime
                : (info.processStartTime ?? null),
          },
          requestId: 'quiesce-test',
        }),
      ),
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
    await daemon.runtime.shutdown();
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
    await daemon.runtime.shutdown();
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
    await daemon.runtime.shutdown();
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
      params: buildDaemonQuiesceRequest({
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
    await daemon.runtime.shutdown();
  }
});

test('a local HTTP quiesce drains an idle daemon like a socket one', async () => {
  const daemon = await bootDaemon({ serverMode: 'dual' });
  const body = await quiesceOverHttp(daemon, {});
  expect(body.result).toEqual({ ok: true, data: { outcome: 'draining' } });
  expect(await daemon.exit).toBe(0);
});

test('a quiesce asked while the daemon is still starting up is refused as busy, then accepted', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-quiesce-startup-');
  const paths = resolveDaemonPaths(stateDir);
  let openGate: () => void = () => {};
  probe.startupGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let resolveExit: (code: number) => void = () => {};
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
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
    exit: resolveExit,
    registerProcessHandlers: false,
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

    const quiesceRequest = buildDaemonQuiesceRequest({
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
    await starting;
    const again = await sendSocketRequest(info.port, quiesceRequest);
    expect(again).toEqual({ ok: true, data: { outcome: 'draining' } });
    expect(await exit).toBe(0);
    expect(fs.existsSync(paths.infoPath)).toBe(false);
  } finally {
    openGate();
    await starting.then((runtime) => runtime?.shutdown());
  }
});
