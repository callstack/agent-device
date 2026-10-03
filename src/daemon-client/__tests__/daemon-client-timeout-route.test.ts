// Production-seam coverage for the real request-timeout route (#3177).
// daemon-client-timeout.test.ts pins the hint wording; a pure formatter test cannot catch a bug
// in RECOVERY SCOPE — whether a timed-out request kills processes it does not own. The route used
// to do two host-scoped things on every local timeout: a `pkill -f` sweep matching every
// agent-device runner xcodebuild on the host, and a daemon SIGKILL for every reset-policy
// command. Both are scoped now: destroying the timed-out connection is the daemon's request-scoped
// cancel, and the SIGKILL runs only for a daemon that answers neither liveness-probe endpoint.
// Each stand-in below answers or refuses BY CONNECTION ORDER (RPC first, the probe's fresh
// connection after) and counts connections, so every row drives the real route to a known verdict
// AND proves whether the route asked at all. The recorded pid is always the test process — not an
// agent-device daemon and with no processStartTime — so the reset path's identity gate refuses a
// real signal: these tests prove WHICH branch the route takes and never signal a process.

import net from 'node:net';
import http from 'node:http';

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test, vi } from 'vitest';

const { mockRunCmdSync, mockIsDaemon, mockStop } = vi.hoisted(() => ({
  mockRunCmdSync: vi.fn(),
  mockIsDaemon: vi.fn(),
  mockStop: vi.fn(),
}));
vi.mock('../../daemon-process.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../daemon-process.ts')>()),
  isAgentDeviceDaemonProcess: mockIsDaemon,
  stopDaemonProcess: mockStop,
}));

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

function seedResettableMetadata(paths: DaemonPaths): void {
  // A reset clears the metadata it can no longer trust; seeding it lets the reset-path row
  // observe removal instead of asserting an absence that was never a presence.
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(paths.infoPath, JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(paths.lockPath, JSON.stringify({ pid: process.pid }));
}

function buildRequest(command: string, platform: 'android' | 'ios' | undefined): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command,
    positionals: [],
    flags: platform ? { platform } : {},
    meta: { requestId: 'req-timeout-route' },
  };
}

/**
 * A daemon stand-in whose FIRST connection (the RPC) is accepted and never answered, so the
 * client's own envelope cuts the round trip off, and whose LATER connections — the timeout
 * handler's fresh probe — either answer like a live daemon (`answer`) or are destroyed
 * unanswered (`refuse`, the wedged daemon the reset path is built for: fails the probe fast
 * instead of spending its window). `connections` proves whether the route asked at all.
 */
async function startStandIn(
  transport: 'http' | 'socket',
  afterFirst: 'answer' | 'refuse',
): Promise<{ server: LoopbackServer; port: number; connections: () => number }> {
  let connections = 0;
  const server: LoopbackServer =
    transport === 'http'
      ? http.createServer((req, res) => {
          const connection = ++connections;
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
}

beforeEach(() => {
  mockRunCmdSync.mockReset();
  mockIsDaemon.mockReset();
  mockStop.mockReset();
});
afterEach(() => vi.restoreAllMocks());

type RouteRow = Readonly<{
  name: string;
  transport: 'http' | 'socket' | 'remote';
  command: string;
  platform: 'android' | 'ios' | undefined;
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

for (const row of ROUTE_ROWS) {
  test(`request-timeout route: ${row.name}`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const daemon = await startStandIn(
      row.transport === 'remote' ? 'http' : row.transport,
      row.afterFirst,
    );
    // Seeded for every row: a preserved daemon must still OWN its metadata, so the assertion is
    // two-sided instead of an absence that was never a presence.
    const statePaths = dummyStatePaths();
    seedResettableMetadata(statePaths);
    try {
      const info: DaemonInfo =
        row.transport === 'remote'
          ? { baseUrl: `http://127.0.0.1:${daemon.port}`, token: 'test-token', pid: process.pid }
          : row.transport === 'http'
            ? { httpPort: daemon.port, token: 'test-token', pid: process.pid }
            : { port: daemon.port, token: 'test-token', pid: process.pid };
      await expectRouteError(
        sendRequest(
          info,
          buildRequest(row.command, row.platform),
          row.transport === 'remote' ? 'http' : row.transport,
          statePaths,
          TIMEOUT_MS,
        ),
        row.hintPattern,
      );
      assert.equal(daemon.connections(), row.connections, 'probe-vs-skip is a route decision');
      // A preserved daemon keeps the metadata a reset would clear; a proved-unresponsive one
      // loses both files (its pid fails the identity gate, so nothing is signaled — only the
      // bookkeeping a dead daemon cannot release changes).
      assert.equal(
        fs.existsSync(statePaths.infoPath),
        !row.resets,
        row.resets ? 'the reset clears the stale registration' : 'no reset touches metadata',
      );
      assert.equal(fs.existsSync(statePaths.lockPath), !row.resets);
    } finally {
      await closeLoopbackServer(daemon.server);
    }
  });
}

test('a refused timeout fallback preserves the timeout without an unhandled rejection', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // The reset branch's fallback: a SIGKILL the kernel refuses goes through the confirmed-retirement
  // path (#3126), and a retirement that cannot confirm the daemon's exit must surface as the
  // timeout the caller already has — not as an unhandled rejection and not as a different error.
  // The stand-in refuses the probe's fresh connection, so this row really does reach the reset.
  mockIsDaemon.mockReturnValue(true);
  mockStop.mockResolvedValue({ status: 'retained', reason: 'exit-timeout' });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('refused'), { code: 'EPERM' });
  });
  const daemon = await startStandIn('socket', 'refuse');
  try {
    await assert.rejects(
      sendRequest(
        { port: daemon.port, pid: 7, token: 'test-token', processStartTime: 'start' },
        buildRequest(RESET_POLICY_COMMAND, undefined),
        'socket',
        dummyStatePaths(),
        TIMEOUT_MS,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'daemon_transport_timeout');
        return true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mockStop.mock.calls.length, 1);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});
