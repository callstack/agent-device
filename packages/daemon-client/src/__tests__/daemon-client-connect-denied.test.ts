import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import { afterEach, test, vi } from 'vitest';
import { runCmdBackground } from '@agent-device/host-kit/command';
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
import { probeLoopbackPort } from '../daemon-client-loopback-probe.ts';
import { currentDaemonCodeSignature } from './code-signature-fixture.ts';

// A loopback connect the HOST refused (EPERM under a macOS Seatbelt sandbox around this client) is
// evidence about this client, not about the registered daemon. These cases pin that the client names
// that refusal instead of judging the daemon dead and trying to replace it.

const DENIED_ERRNO = 'EPERM';

const { mockProbeAnswers, mockSpawnDaemon } = vi.hoisted(() => ({
  /** What each probe of the registered daemon answers, in order; `denied` is a host refusal. */
  mockProbeAnswers: [] as ('denied' | 'silent')[],
  mockSpawnDaemon: vi.fn(),
}));

vi.mock('../daemon-client-transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon-client-transport.ts')>();
  return {
    ...actual,
    probeDaemonReachability: async (...args: Parameters<typeof actual.probeDaemonReachability>) => {
      const answer = mockProbeAnswers.shift() ?? 'silent';
      if (answer !== 'denied') return { reachable: false };
      return {
        reachable: false,
        denial: { errno: DENIED_ERRNO, transport: 'socket', port: args[0].port ?? 0 },
      };
    },
  };
});

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmdDetachedMonitored: mockSpawnDaemon };
});

afterEach(() => {
  mockProbeAnswers.length = 0;
  mockSpawnDaemon.mockReset();
});

/**
 * A stand-in for the daemon running OUTSIDE the sandbox: a live process whose command reads as an
 * agent-device daemon, plus a registration this client wrote by hand. The client never started this
 * lifetime, so an unreachable judgement lands as a retirement it may not confirm.
 */
async function withRegisteredStandIn(
  t: { skip: (reason: string) => void },
  body: (input: { stateDir: string; pid: number }) => Promise<void>,
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
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const processStartTime = readProcessStartTime(pid) ?? undefined;
    const command = readProcessCommand(pid);
    if (command === null || processStartTime === undefined) {
      t.skip('process command/start inspection is unavailable in this environment');
      return;
    }
    const port = await listenOnLoopback(server);
    const paths = resolveDaemonPaths(stateDir);
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(
      paths.infoPath,
      `${JSON.stringify({
        port,
        transport: 'socket',
        token: 'local-secret',
        pid,
        version: readVersion(),
        processStartTime,
        codeSignature: currentDaemonCodeSignature(),
      })}\n`,
      'utf8',
    );
    await body({ stateDir, pid });
  } finally {
    await closeLoopbackServer(server);
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
      await waitForProcessExit(pid, 1_500);
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function sendDevices(stateDir: string) {
  return sendToDaemon({
    session: 'default',
    command: 'devices',
    positionals: [],
    flags: { stateDir, daemonTransport: 'socket' },
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
    mockProbeAnswers.push('denied');

    const failure = await rejection(sendDevices(stateDir));

    assert.equal(failure.details?.reason, 'daemon-connect-denied');
    assert.equal(failure.details?.errno, DENIED_ERRNO);
    assert.equal((failure.details?.daemon as { pid?: number } | undefined)?.pid, pid);
    assert.match(String(failure.details?.hint), /A sandbox around this command/);
    assert.match(String(failure.details?.hint), /host access/);
    assert.equal(mockSpawnDaemon.mock.calls.length, 0, 'a refusal is not a dead daemon to replace');
    assert.equal(isProcessAlive(pid), true, 'the daemon outside the sandbox is not signaled');
  });
});

test('a probe that goes unanswered is still judged unreachable, not denied', async (t) => {
  await withRegisteredStandIn(t, async ({ stateDir, pid }) => {
    mockProbeAnswers.push('silent', 'silent', 'silent', 'silent');

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
