// Timeout recovery through the real socket/HTTP route. Connection counts distinguish the timed-out
// RPC from the fresh liveness probe. Confirmed reset controls use owned registration children;
// missing or superseded identity must retain state. No control signals an unrelated process.

import net from 'node:net';
import http from 'node:http';

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test, vi } from 'vitest';

const { mockRunCmdSync, mockEmitDiagnostic } = vi.hoisted(() => ({
  mockRunCmdSync: vi.fn(),
  mockEmitDiagnostic: vi.fn(),
}));

// Records what the route reported while still emitting for real: the timeout's own diagnostic is
// expected, a transport-failure diagnostic for the same request is not.
vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return {
    ...actual,
    emitDiagnostic: (...args: Parameters<typeof actual.emitDiagnostic>) => {
      mockEmitDiagnostic(...args);
      actual.emitDiagnostic(...args);
    },
  };
});

vi.mock('@agent-device/host-kit/command', async () => {
  const actual = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
    '@agent-device/host-kit/command',
  );
  return { ...actual, runCmdSync: mockRunCmdSync };
});

import { AppError } from '@agent-device/kernel/errors';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { sendRequest } from '../daemon-client-transport.ts';
import type { DaemonRequest } from '../../daemon/daemon-request.ts';
import type { DaemonInfo } from '../daemon-client-metadata.ts';
import type { DaemonPaths } from '../../daemon-resolution.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
  type LoopbackServer,
} from '../../__tests__/test-utils/loopback.ts';

import {
  spawnRegisteredDaemonFixture,
  waitForRegisteredDaemonFixture,
  finishRegisteredDaemonFixtures,
} from '../../__tests__/test-utils/registered-daemon-fixture.ts';

async function registeredOwner(paths: DaemonPaths, port: number, transport: 'http' | 'socket') {
  const child = spawnRegisteredDaemonFixture(
    paths,
    {
      ...(transport === 'http' ? { httpPort: port } : { socketPort: port }),
      token: 'test-token',
      version: 'test',
      codeOrigin: 'checkout',
      codeSignature: 'test',
    },
    undefined,
  );
  return await waitForRegisteredDaemonFixture(paths, child);
}

const TIMEOUT_MS = 60;

// A reset-ELIGIBLE policy command — exercised only if the probe finds the daemon unresponsive;
// `open` is the command from the motivating report (#3177). A preserve-daemon command (`snapshot`)
// makes no reset reachable, so the probe must never run for it.
const RESET_POLICY_COMMAND = PUBLIC_COMMANDS.open;
const PRESERVE_POLICY_COMMAND = PUBLIC_COMMANDS.snapshot;

function dummyStatePaths(): DaemonPaths {
  const baseDir = path.join(
    mkdtempForTestSync('agent-device-timeout-route-test'),
    'agent-device-timeout-route-test',
  );
  const paths: DaemonPaths = {
    baseDir,
    infoPath: path.join(baseDir, 'daemon.json'),
    lockPath: path.join(baseDir, 'daemon.lock'),
    logPath: path.join(baseDir, 'daemon.log'),
    allocationsDir: path.join(baseDir, 'allocations'),
    sessionsDir: path.join(baseDir, 'sessions'),
  };
  return paths;
}

// The start time the seeded registration and the request's DaemonInfo agree on. The ownership
// fence only deletes a record that MATCHES the timed-out daemon on pid and start time, so a row
// that expects removal has to name both. The pid is the test process, which fails the identity
// gate (`isAgentDeviceDaemonProcess`) on its real start time: these tests prove WHICH branch the
// route takes and never signal a process.
const TEST_DAEMON_START_TIME = 'test-start-time';
// A registration whose pid and start time BOTH differ from the timed-out daemon: proof of a
// replacement (#3125), which the ownership fence must refuse to delete.
const REPLACEMENT_DAEMON_PID = 99_999;

function seedRegistration(paths: DaemonPaths, owner: { pid: number; startTime: string }): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    JSON.stringify({ pid: owner.pid, processStartTime: owner.startTime }),
  );
}

function seedProtocolLockDir(paths: DaemonPaths, owner: { pid: number; startTime: string }): void {
  // `daemon.lock` is the ADR 0030 directory, not a file: seeding it shaped like production means
  // a reset that still deleted it out-of-band would be RECLAIMING someone else's lock, and the
  // survival assertion below catches that. (The pre-fix `unlinkSync` even failed on this shape.)
  fs.mkdirSync(path.join(paths.lockPath), { recursive: true });
  fs.writeFileSync(
    path.join(paths.lockPath, 'owner.json'),
    JSON.stringify({ pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() }),
  );
}

function buildRequest(
  command: string,
  platform: 'android' | 'ios' | undefined,
  positionals: readonly string[] = [],
): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command,
    positionals: [...positionals],
    flags: platform ? { platform } : {},
    meta: { requestId: 'req-timeout-route' },
  };
}

/**
 * A daemon stand-in whose FIRST connection (the RPC) is accepted and never answered, so the
 * client's own envelope cuts the round trip off, and whose LATER connections — the timeout
 * handler's fresh probe — either answer like a live daemon (`answer`) or are destroyed
 * unanswered (`refuse`, the wedged daemon the reset path is built for: fails the probe fast
 * instead of spending its window).
 *
 * `connections` counts accepted TCP connections, NOT requests: the probe's whole claim is that it
 * asks on a FRESH connection, so an HTTP request counter — which an RPC kept alive by keep-alive
 * would also advance — would let the probe pass by reusing the timed-out socket. The stand-in only
 * answers `/health` on a connection after the first, so a row that reaches its kept-alive hint is
 * simultaneously proving a fresh connection carried a health request.
 */
async function startStandIn(
  transport: 'http' | 'socket',
  afterFirst: 'answer' | 'refuse',
): Promise<{ server: LoopbackServer; port: number; connections: () => number }> {
  let connections = 0;
  // The TCP ordinal lives on the socket the request arrived on, so two requests sharing one
  // socket (keep-alive) count as one connection: the probe's claim is a FRESH connection, and a
  // request counter would advance for an RPC kept alive on the timed-out socket too.
  type OrdinalSocket = { __connectionOrdinal?: number };
  const server: LoopbackServer =
    transport === 'http'
      ? http.createServer((req, res) => {
          const connection = (req.socket as OrdinalSocket).__connectionOrdinal ?? 0;
          if (connection > 1 && afterFirst === 'answer' && req.url === '/health') {
            res.statusCode = 200;
            res.end('{}');
            return;
          }
          if (connection > 1) {
            res.destroy();
            return;
          }
          res.on('error', () => {});
        })
      : net.createServer((socket) => {
          const connection = ++connections;
          socket.on('error', () => {});
          if (connection === 1) return;
          if (afterFirst === 'refuse') {
            socket.destroy();
            return;
          }
          socket.on('data', () => {
            socket.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: 'probe', result: { ok: true } })}\n`,
            );
          });
        });
  if (transport === 'http') {
    (server as http.Server).on('clientError', (_err, socket) => socket.destroy());
    (server as http.Server).on('connection', (socket) => {
      (socket as OrdinalSocket).__connectionOrdinal = ++connections;
    });
  }
  const port = await listenOnLoopback(server);
  return { server, port, connections: () => connections };
}

async function expectRouteError(run: Promise<unknown>, hintPattern: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await run;
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof AppError, 'the route must reject with a typed AppError');
  assert.match(String(thrown.details?.hint), hintPattern);
  // The regression this suite exists to catch: no host-wide process sweep, whatever the request
  // declared.
  assert.equal(mockRunCmdSync.mock.calls.length, 0);
  // The timeout settles the request and then destroys it, so the transport's `error` event lands
  // AFTER the rejection. A timed-out request must not also be diagnosed as a transport FAILURE —
  // that describes a canceled request as a broken host and buries the timeout's own reason. The
  // destroy surfaces on a later tick, so give it one before reading the record.
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(
    mockEmitDiagnostic.mock.calls
      .map(([entry]) => (entry as { phase?: string })?.phase)
      .filter((phase) => phase === 'daemon_request_socket_error'),
    [],
    'a timeout must not also diagnose a transport failure',
  );
}

beforeEach(() => {
  mockRunCmdSync.mockReset();
  mockEmitDiagnostic.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await finishRegisteredDaemonFixtures();
});

type RouteRow = Readonly<{
  name: string;
  transport: 'http' | 'socket' | 'remote';
  command: string;
  platform: 'android' | 'ios' | undefined;
  positionals?: readonly string[];
  afterFirst: 'answer' | 'refuse';
  hintPattern: RegExp;
  // The connections the stand-in must observe: 1 = the RPC only (route never probed),
  // 2 = RPC + probe.
  connections: 1 | 2;
  /** Whether this row's verdict is the reset branch, which clears the daemon's metadata. */
  resets: boolean;
}>;

// The `ios` declarations are deliberate: eligibility never keyed off the declared platform, and
// neither may recovery. The prepare follow-up on the snapshot row is keyed on a declared Apple
// platform — the only Apple evidence this route can back up now that the sweep is gone.
const ROUTE_ROWS: readonly RouteRow[] = [
  {
    name: 'keeps a responsive daemon alive (the motivating #3177 case)',
    transport: 'http',
    command: RESET_POLICY_COMMAND,
    platform: 'ios',
    afterFirst: 'answer',
    hintPattern: /The timed-out open request was canceled; the daemon was kept alive/,
    connections: 2,
    resets: false,
  },
  {
    name: 'is proven responsive over the socket transport',
    transport: 'socket',
    command: RESET_POLICY_COMMAND,
    platform: undefined,
    afterFirst: 'answer',
    hintPattern: /the daemon was kept alive so the session can still be closed or inspected/,
    connections: 2,
    resets: false,
  },
  {
    name: 'resets a daemon that answers no probe endpoint',
    transport: 'socket',
    command: RESET_POLICY_COMMAND,
    platform: undefined,
    afterFirst: 'refuse',
    hintPattern: /The daemon did not answer the liveness probe and was reset after the timeout/,
    connections: 2,
    resets: true,
  },
  {
    // `snapshot` declares preserve-daemon: no reset is reachable, so the probe would be pure
    // latency and the route must skip it entirely.
    name: 'skips the probe for a preserve-policy command',
    transport: 'http',
    command: PRESERVE_POLICY_COMMAND,
    platform: 'ios',
    afterFirst: 'answer',
    hintPattern:
      /The timed-out snapshot request was canceled; the daemon was kept alive.*prepare ios-runner/s,
    connections: 1,
    resets: false,
  },
  {
    // `record` declares preserve-daemon (#3199), so a LOCAL timed-out `record stop` reaches the
    // retry hint without the probe ever running: the export the surviving daemon may still be
    // finishing must not lose the runner to a sweep either (#3177 removed the sweep for all
    // commands; this row pins that it is gone for the recorder too, on the real action positional).
    name: 'names the record stop retry without probing a preserve-policy recorder',
    transport: 'socket',
    command: PUBLIC_COMMANDS.record,
    platform: 'ios',
    positionals: ['stop'],
    afterFirst: 'answer',
    hintPattern:
      /^The daemon may still be exporting the recording\. Run agent-device record stop --session default again/,
    connections: 1,
    resets: false,
  },
  {
    // A remote client cannot reset anything on the daemon's host: no probe window, no sweep.
    name: 'keeps a remote timeout declarative',
    transport: 'remote',
    command: RESET_POLICY_COMMAND,
    platform: 'android',
    afterFirst: 'answer',
    hintPattern: /verify the remote daemon URL, auth token, and remote host logs/,
    connections: 1,
    resets: false,
  },
];

function standInInfo(row: RouteRow, port: number): DaemonInfo {
  const identity = {
    token: 'test-token',
    pid: process.pid,
    processStartTime: TEST_DAEMON_START_TIME,
  };
  if (row.transport === 'remote') return { ...identity, baseUrl: `http://127.0.0.1:${port}` };
  return row.transport === 'http' ? { ...identity, httpPort: port } : { ...identity, port };
}

for (const row of ROUTE_ROWS) {
  test(`request-timeout route: ${row.name}`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const daemon = await startStandIn(
      row.transport === 'remote' ? 'http' : row.transport,
      row.afterFirst,
    );
    // Preserved rows retain seeded metadata. Reset rows acquire a real child-owned registration.
    const statePaths = dummyStatePaths();
    const owned = { pid: process.pid, startTime: TEST_DAEMON_START_TIME };
    if (!row.resets) {
      seedRegistration(statePaths, owned);
      seedProtocolLockDir(statePaths, owned);
    }
    const registered = row.resets
      ? await registeredOwner(statePaths, daemon.port, row.transport === 'http' ? 'http' : 'socket')
      : undefined;
    try {
      const info = registered ?? standInInfo(row, daemon.port);
      await expectRouteError(
        sendRequest(
          info,
          buildRequest(row.command, row.platform, row.positionals),
          row.transport === 'remote' ? 'http' : row.transport,
          statePaths,
          TIMEOUT_MS,
        ),
        row.hintPattern,
      );
      assert.equal(daemon.connections(), row.connections, 'probe-vs-skip is a route decision');
      assert.equal(
        fs.existsSync(statePaths.infoPath),
        !row.resets,
        row.resets ? 'the reset clears the owned registration' : 'no reset touches metadata',
      );
      assert.equal(
        fs.existsSync(statePaths.lockPath),
        !row.resets,
        'only confirmed retirement releases the owned lock',
      );
    } finally {
      await closeLoopbackServer(daemon.server);
    }
  });
}

test('request-timeout route: a reset never deletes a registration a replacement daemon published', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // The probe window is exactly when another client can start a replacement daemon and publish
  // ITS record (#3177 review, on top of #3125's fence). The timed-out request's info still names
  // the wedged pid, so the reset must read the record before clearing it: here it names a
  // different owner, and deleting it would orphan the live replacement — the same class of
  // host-scoped damage this PR removes everywhere else.
  const daemon = await startStandIn('socket', 'refuse');
  const statePaths = dummyStatePaths();
  seedRegistration(statePaths, { pid: REPLACEMENT_DAEMON_PID, startTime: 'replacement-start' });
  seedProtocolLockDir(statePaths, { pid: process.pid, startTime: TEST_DAEMON_START_TIME });
  try {
    await expectRouteError(
      sendRequest(
        {
          port: daemon.port,
          token: 'test-token',
          pid: process.pid,
          processStartTime: TEST_DAEMON_START_TIME,
        },
        buildRequest(RESET_POLICY_COMMAND, undefined),
        'socket',
        statePaths,
        TIMEOUT_MS,
      ),
      /The daemon could not be safely retired/,
    );
    assert.ok(
      fs.existsSync(statePaths.infoPath),
      'the replacement keeps the registration it published',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(statePaths.infoPath, 'utf8')).pid,
      REPLACEMENT_DAEMON_PID,
    );
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

test('a refused timeout fallback preserves the timeout without an unhandled rejection', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // The reset branch's fallback: a SIGKILL the kernel refuses goes through the confirmed-retirement
  // path (#3126), and a retirement that cannot confirm the daemon's exit must surface as the
  // timeout the caller already has — not as an unhandled rejection and not as a different error.
  // The stand-in refuses the probe's fresh connection, so this row really does reach the reset.
  const daemon = await startStandIn('socket', 'refuse');
  const paths = dummyStatePaths();
  const info = await registeredOwner(paths, daemon.port, 'socket');
  const actualKill = process.kill.bind(process);
  const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === info.pid && signal !== 0)
      throw Object.assign(new Error('refused'), { code: 'EPERM' });
    return actualKill(pid, signal);
  });
  try {
    await assert.rejects(
      sendRequest(info, buildRequest(RESET_POLICY_COMMAND, undefined), 'socket', paths, TIMEOUT_MS),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'daemon_transport_timeout');
        return true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(killSpy.mock.calls.some(([pid, signal]) => pid === info.pid && signal === 'SIGKILL'));
    assert.ok(fs.existsSync(paths.infoPath));
    assert.ok(fs.existsSync(paths.lockPath));
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

test('request-timeout route: the reset acts on the resolved state paths, not the request flags', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // Path resolution happens upstream of `sendRequest`, which receives the state paths the caller
  // resolved. The reset must clear THAT registration and leave every other state dir alone — even
  // one a request flag names, which this route never reads. (Moved from daemon-client-lifecycle
  // coverage, where the timeout route lived before #3177 scoped it.)
  const daemon = await startStandIn('http', 'refuse');
  const resolvedPaths = dummyStatePaths();
  const requestFlagPaths = dummyStatePaths();
  const info = await registeredOwner(resolvedPaths, daemon.port, 'http');
  seedRegistration(requestFlagPaths, { pid: REPLACEMENT_DAEMON_PID, startTime: 'other-owner' });
  seedProtocolLockDir(requestFlagPaths, { pid: REPLACEMENT_DAEMON_PID, startTime: 'other-owner' });
  try {
    await expectRouteError(
      sendRequest(
        info,
        {
          ...buildRequest(RESET_POLICY_COMMAND, undefined),
          flags: { stateDir: requestFlagPaths.baseDir },
        },
        'http',
        resolvedPaths,
        TIMEOUT_MS,
      ),
      /The daemon did not answer the liveness probe and was reset after the timeout/,
    );
    assert.ok(!fs.existsSync(resolvedPaths.infoPath), 'the resolved registration is cleared');
    assert.ok(fs.existsSync(requestFlagPaths.infoPath), 'the flag-named state dir is untouched');
    assert.ok(fs.existsSync(requestFlagPaths.lockPath), 'the flag-named lock is untouched');
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});
