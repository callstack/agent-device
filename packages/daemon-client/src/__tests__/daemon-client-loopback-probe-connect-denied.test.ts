import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import { afterEach, test, vi } from 'vitest';
import { runCmdBackground, runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  waitForProcessExit,
} from '@agent-device/host-kit/process';
import { AppError } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { sendToDaemon } from '../index.ts';
import { probeLoopbackPort, readAdvertisedConnectDenial } from '../daemon-client-loopback-probe.ts';
import {
  finishRegisteredDaemonFixture,
  finishRegisteredDaemonFixtures,
  planRegisteredDaemonLaunches,
} from './registered-daemon-fixture.ts';
import { currentDaemonCodeSignature } from './code-signature-fixture.ts';

// A loopback connect the HOST refused (EPERM under a macOS Seatbelt sandbox around this client) is
// evidence about this client, not about the registered daemon. These cases pin that the client names
// that refusal instead of judging the daemon dead and trying to replace it.

const DENIED_ERRNO = 'EPERM';

/** A host refusal to answer a probe with, naming the errno and endpoint family it refused. */
type DeniedProbe = Readonly<{ errno: 'EPERM' | 'EACCES'; transport: 'socket' | 'http' }>;

const { mockProbeAnswers } = vi.hoisted(() => ({
  /**
   * What each probe of the registered daemon answers, in order: `'silent'`, or the refusal the host
   * gave. `null` stands for silence so the list reads as answers, not as verdict shapes.
   */
  mockProbeAnswers: [] as (DeniedProbe | null)[],
}));

function denied(errno: DeniedProbe['errno'], transport: DeniedProbe['transport']): DeniedProbe {
  return { errno, transport };
}

vi.mock('../daemon-client-transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon-client-transport.ts')>();
  return {
    ...actual,
    probeDaemonReachability: async (...args: Parameters<typeof actual.probeDaemonReachability>) => {
      const answer = mockProbeAnswers.shift();
      if (!answer) return { reachable: false };
      // The port is the one this probe aimed at, as the real probe reports it.
      const port = answer.transport === 'http' ? (args[0].httpPort ?? 0) : (args[0].port ?? 0);
      return { reachable: false, denial: { ...answer, port } };
    },
  };
});

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));

const spawnDaemon = vi.mocked(runCmdDetachedMonitored);

afterEach(async () => {
  mockProbeAnswers.length = 0;
  spawnDaemon.mockReset();
  await finishRegisteredDaemonFixtures();
});

/**
 * A stand-in for the daemon running OUTSIDE the sandbox: a live process, plus a registration this
 * client wrote by hand that points at loopback endpoints and this pid. The process is a plain `node
 * -e` stand-in, not a daemon build: what makes it a daemon is the registration and the live pid, and
 * `readProcessCommand` is read only as a skip guard for environments where process inspection is
 * unavailable. The client never started this lifetime, so an unreachable judgement lands as a
 * retirement it may not confirm.
 */
async function withRegisteredStandIn(
  t: { skip: (reason: string) => void },
  body: (input: { stateDir: string; pid: number; port: number; httpPort: number }) => Promise<void>,
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const stateDir = mkdtempForTestSync('agent-device-connect-denied-');
  const standIn = runCmdBackground(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
    allowFailure: true,
    captureOutput: false,
  });
  void standIn.wait.catch(() => {});
  const pid = standIn.child.pid;
  assert.ok(pid, 'the stand-in has a pid');
  const server = net.createServer((socket) => socket.on('error', () => {}));
  const httpServer = net.createServer((socket) => socket.on('error', () => {}));
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const processStartTime = readProcessStartTime(pid) ?? undefined;
    const command = readProcessCommand(pid);
    if (command === null || processStartTime === undefined) {
      t.skip('process command/start inspection is unavailable in this environment');
      return;
    }
    const port = await listenOnLoopback(server);
    const httpPort = await listenOnLoopback(httpServer);
    const paths = resolveDaemonPaths(stateDir);
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(
      paths.infoPath,
      `${JSON.stringify({
        port,
        transport: 'dual',
        httpPort,
        token: 'local-secret',
        pid,
        version: readVersion(),
        processStartTime,
        codeSignature: currentDaemonCodeSignature(),
      })}\n`,
      'utf8',
    );
    await body({ stateDir, pid, port, httpPort });
  } finally {
    await closeLoopbackServer(httpServer);
    await closeLoopbackServer(server);
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
      await waitForProcessExit(pid, 1_500);
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function sendDevices(stateDir: string, transport: 'socket' | 'http' = 'socket') {
  return sendToDaemon({
    session: 'default',
    command: 'devices',
    positionals: [],
    flags: { stateDir, daemonTransport: transport },
    meta: { requestId: 'req-connect-denied' },
  });
}

async function rejection(pending: Promise<unknown>): Promise<AppError> {
  let thrown: AppError | undefined;
  try {
    await pending;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    thrown = error;
  }
  assert.ok(thrown, 'expected the command to reject');
  return thrown;
}

test('a connect the host refused names the sandbox and leaves the daemon running', async (t) => {
  await withRegisteredStandIn(t, async ({ stateDir, pid }) => {
    mockProbeAnswers.push(denied(DENIED_ERRNO, 'socket'));

    const failure = await rejection(sendDevices(stateDir));

    assert.equal(failure.details?.reason, 'daemon-connect-denied');
    assert.equal(failure.details?.errno, DENIED_ERRNO);
    assert.equal((failure.details?.daemon as { pid?: number } | undefined)?.pid, pid);
    assert.match(String(failure.details?.hint), /A sandbox around this command/);
    assert.match(String(failure.details?.hint), /host access/);
    assert.equal(spawnDaemon.mock.calls.length, 0, 'a refusal is not a dead daemon to replace');
    assert.equal(isProcessAlive(pid), true, 'the daemon outside the sandbox is not signaled');
  });
});

// Both endpoint families and both refused errnos have to reach the caller with the details they were
// refused with: a regression that dropped `transport` or rewrote `errno` would otherwise pass here.
// The stand-in daemon serves both endpoints, so the client probes its socket leg first and falls back
// to HTTP: an HTTP refusal therefore arrives as the SECOND leg's answer, which is the shape a real
// sandbox produces when it refuses only the family the socket leg does not cover.
test.for([
  { errno: 'EPERM', leg: 'socket' },
  { errno: 'EACCES', leg: 'socket' },
  { errno: 'EACCES', leg: 'http' },
  { errno: 'EPERM', leg: 'http' },
] as const)(
  'a refusal of the %s endpoint with %s reports both in the reason details',
  async ({ errno, leg }, t) => {
    await withRegisteredStandIn(t, async ({ stateDir, pid, port, httpPort }) => {
      mockProbeAnswers.push(denied(errno, leg));

      // The client is pinned to the leg under test, so the refusal it reports is that leg's.
      const failure = await rejection(sendDevices(stateDir, leg));

      assert.equal(failure.details?.reason, 'daemon-connect-denied');
      assert.equal(failure.details?.errno, errno);
      assert.equal(failure.details?.transport, leg);
      assert.equal(failure.details?.port, leg === 'http' ? httpPort : port);
      assert.equal((failure.details?.daemon as { pid?: number } | undefined)?.pid, pid);
      assert.equal(spawnDaemon.mock.calls.length, 0);
      assert.equal(isProcessAlive(pid), true);
    });
  },
);

// A daemon the CLIENT launched, whose registration its own startup watch then read: the readiness
// probe is the first connect after publication. When the host refuses that connect, readiness cannot
// be judged, and the stalled and ceiling routes would signal a daemon this client cannot see. The
// launch seam starts a real registration-owning child, so the client owns this lifetime.
test('a launched daemon whose readiness connect the host refused is left running', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const stateDir = mkdtempForTestSync('agent-device-launch-denied-');
  const paths = resolveDaemonPaths(stateDir);
  const server = net.createServer((socket) => socket.on('error', () => {}));
  const httpPort = await listenOnLoopback(server);
  spawnDaemon.mockImplementation(
    planRegisteredDaemonLaunches([
      {
        kind: 'registered',
        paths,
        fields: {
          httpPort,
          token: 'local-secret',
          version: readVersion(),
          codeOrigin: 'checkout',
          codeSignature: currentDaemonCodeSignature(),
        },
      },
    ]),
  );
  mockProbeAnswers.push(denied(DENIED_ERRNO, 'http'));

  try {
    const failure = await rejection(sendDevices(stateDir, 'http'));

    assert.equal(failure.details?.reason, 'daemon-connect-denied');
    assert.equal(failure.details?.errno, DENIED_ERRNO);
    assert.equal(failure.details?.transport, 'http');
    // The client is pinned to HTTP, so the readiness probe reports that leg's advertised port.
    assert.equal(failure.details?.port, httpPort);
    const launched = failure.details?.daemon as { pid?: number } | undefined;
    assert.ok(
      launched?.pid !== undefined && isProcessAlive(launched.pid),
      'the daemon the client launched keeps running',
    );
    assert.ok(fs.existsSync(paths.infoPath), 'its registration is left in place');
  } finally {
    await finishRegisteredDaemonFixture(stateDir);
    fs.rmSync(stateDir, { recursive: true, force: true });
    await closeLoopbackServer(server);
  }
});

// An attach client starts and replaces nothing anyway, so its only wrong answer would read as "no
// daemon is running" and send the caller to start one it cannot reach either.
test('an attach client told about a refusal does not report a daemon that is not running', async (t) => {
  await withRegisteredStandIn(t, async ({ stateDir, pid }) => {
    mockProbeAnswers.push(denied(DENIED_ERRNO, 'socket'));

    const failure = await rejection(
      sendToDaemon(
        {
          session: 'default',
          command: 'devices',
          positionals: [],
          flags: { stateDir, daemonTransport: 'socket' },
          meta: { requestId: 'req-attach-denied' },
        },
        { daemonLifecycle: 'attach' },
      ),
    );

    assert.equal(failure.details?.reason, 'daemon-connect-denied');
    assert.equal(failure.details?.errno, DENIED_ERRNO);
    assert.equal((failure.details?.daemon as { pid?: number } | undefined)?.pid, pid);
    assert.equal(isProcessAlive(pid), true, 'an attach client signals nothing either');
  });
});

test('a probe that goes unanswered is still judged unreachable, not denied', async (t) => {
  await withRegisteredStandIn(t, async ({ stateDir, pid }) => {
    mockProbeAnswers.push(null, null, null, null);

    const failure = await rejection(sendDevices(stateDir));

    // The judgement this fix replaces for a refusal: an unanswered probe keeps the old outcome, so
    // the denial is a new verdict rather than a relabelled one.
    assert.equal(failure.details?.reason, 'daemon_retirement_unconfirmed');
    assert.notEqual(failure.details?.errno, DENIED_ERRNO);
    assert.equal(isProcessAlive(pid), true, 'a client that cannot confirm a stop signals nothing');
  });
});

test.for(['EPERM', 'EACCES', 'ECONNREFUSED', 'ECONNRESET'] as const)(
  'probeLoopbackPort reports only the refused errnos as a denial (%s)',
  async (code) => {
    const socket = Object.assign(new EventEmitter(), {
      destroy: () => {},
      setTimeout: () => socket,
    });
    const createConnection = vi.spyOn(net, 'createConnection').mockImplementation(((
      _options: unknown,
      _listener?: () => void,
    ) => {
      setImmediate(() => socket.emit('error', Object.assign(new Error(code), { code })));
      return socket;
    }) as unknown as typeof net.createConnection);
    try {
      const probe = await probeLoopbackPort(65_530, 'http', 500);
      assert.deepEqual(probe, {
        reachable: false,
        ...(code === 'EPERM' || code === 'EACCES'
          ? { denial: { errno: code, transport: 'http', port: 65_530 } }
          : {}),
      });
    } finally {
      createConnection.mockRestore();
    }
  },
);

// The guard a replacement takes out is a permission question, so it must not ask anything a daemon
// could answer: no health request, and no wait step. These assertions hold it to that.
test('the pre-replacement guard asks one bare connect per advertised port and nothing else', async () => {
  const connected: Array<{ port: number }> = [];
  const refused = Object.assign(new EventEmitter(), {
    destroy: () => {},
    setTimeout: () => refused,
  });
  const createConnection = vi.spyOn(net, 'createConnection').mockImplementation(((
    options: { port: number },
    _listener?: () => void,
  ) => {
    // Records the port only: one entry per advertised endpoint is the whole claim, and the socket port
    // is asked first, so the refusal this returns names that endpoint.
    connected.push({ port: options.port });
    setImmediate(() =>
      refused.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' })),
    );
    return refused;
  }) as unknown as typeof net.createConnection);
  try {
    const denial = await readAdvertisedConnectDenial({
      port: 65_540,
      httpPort: 65_541,
      remote: false,
    });

    assert.deepEqual(denial, { errno: 'EACCES', transport: 'socket', port: 65_540 });
    assert.deepEqual(connected, [{ port: 65_540 }, { port: 65_541 }]);
  } finally {
    createConnection.mockRestore();
  }
});

// A remote registration is out of scope: a refusal to reach a remote host is not the loopback denial
// this verdict names, and connecting to it would send a request the guard has no business making.
test('the pre-replacement guard asks nothing of a remote registration', async () => {
  const createConnection = vi.spyOn(net, 'createConnection').mockImplementation(() => {
    throw new Error('a remote registration is not probed');
  });
  try {
    assert.equal(
      await readAdvertisedConnectDenial({ port: 65_540, httpPort: 65_541, remote: true }),
      undefined,
    );
  } finally {
    createConnection.mockRestore();
  }
});
