import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test, vi } from 'vitest';
import { runCmdBackground } from '@agent-device/host-kit/command';
import { computeDaemonCodeSignature } from '@agent-device/host-kit/code-signature';
import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  waitForProcessExit,
} from '@agent-device/host-kit/process';
import { findProjectRoot, readVersion } from '@agent-device/host-kit/version';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { sendToDaemon } from '../daemon-client.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  supportsLoopbackBind,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { AppError } from '@agent-device/kernel/errors';

const NEWER_DAEMON_VERSION = '999.0.0';

// The spawned stand-in's identity is read once and pinned: a second real `ps` can miss its
// deadline under suite load and misclassify the live process as gone.
const { mockReadProcessStartTime, mockReadProcessCommand } = vi.hoisted(() => ({
  mockReadProcessStartTime: vi.fn<(pid: number) => string | null | undefined>(),
  mockReadProcessCommand: vi.fn<(pid: number) => string | null | undefined>(),
}));

// Every probe's answer, in order, with the port it asked; a test can also make the next one miss.
const { probeAnswers, probedPorts, mockMissNextProbe, mockEmitDiagnostic, mockSpawnDaemon } =
  vi.hoisted(() => ({
    probeAnswers: [] as boolean[],
    probedPorts: [] as (number | undefined)[],
    mockMissNextProbe: { value: false },
    mockEmitDiagnostic: vi.fn(),
    mockSpawnDaemon: vi.fn(),
  }));

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

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmdDetachedMonitored: mockSpawnDaemon };
});

vi.mock('../daemon-client-transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon-client-transport.ts')>();
  return {
    ...actual,
    canConnect: async (...args: Parameters<typeof actual.canConnect>) => {
      const reachable = mockMissNextProbe.value ? false : await actual.canConnect(...args);
      mockMissNextProbe.value = false;
      probeAnswers.push(reachable);
      probedPorts.push(args[0].port);
      return reachable;
    },
  };
});

vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return {
    ...actual,
    readProcessStartTime: (pid: number) =>
      mockReadProcessStartTime(pid) ?? actual.readProcessStartTime(pid),
    readProcessCommand: (pid: number) =>
      mockReadProcessCommand(pid) ?? actual.readProcessCommand(pid),
  };
});

function resolveCurrentDaemonCodeSignature(): string {
  const root = findProjectRoot();
  const distPath = path.join(root, 'dist', 'src', 'internal', 'daemon.js');
  const sourcePath = path.join(root, 'src', 'daemon.ts');
  const entryPath =
    process.execArgv.includes('--experimental-strip-types') || !fs.existsSync(distPath)
      ? sourcePath
      : distPath;
  return computeDaemonCodeSignature(entryPath, root);
}

type LiveStandIn = { stateDir: string; pid: number };

/**
 * Runs `body` against a daemon.json naming a live process that reads as an agent-device daemon
 * and a loopback socket that answers every request, as a running daemon does.
 */
async function withLiveStandIn(
  t: { skip: (reason: string) => void },
  version: string,
  body: (standIn: LiveStandIn) => Promise<void>,
): Promise<void> {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  const stateDir = mkdtempForTestSync('agent-device-stalled-probe-');
  const root = mkdtempForTestSync('agent-device-stalled-probe-daemon-');
  const daemonDir = path.join(root, 'agent-device', 'dist', 'src', 'internal');
  const daemonScriptPath = path.join(daemonDir, 'daemon.js');
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(daemonScriptPath, 'setInterval(() => {}, 1000);\n', 'utf8');
  const daemonProcess = runCmdBackground(process.execPath, [daemonScriptPath], {
    stdio: 'ignore',
    allowFailure: true,
    captureOutput: false,
  });
  void daemonProcess.wait.catch(() => {});
  const pid = daemonProcess.child.pid;
  assert.ok(pid, 'spawned child should have a pid');
  const server = net.createServer((socket) => {
    let requestBody = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      requestBody += chunk;
      if (!requestBody.includes('\n')) return;
      socket.end(`${JSON.stringify({ ok: true, data: { via: 'live-daemon' } })}\n`);
    });
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const processStartTime = readProcessStartTime(pid) ?? undefined;
    const command = readProcessCommand(pid);
    if (command === null || processStartTime === undefined) {
      t.skip('process command/start inspection is unavailable in this environment');
      return;
    }
    mockReadProcessStartTime.mockImplementation((queriedPid: number) =>
      queriedPid === pid ? processStartTime : undefined,
    );
    mockReadProcessCommand.mockImplementation((queriedPid: number) =>
      queriedPid === pid ? command : undefined,
    );
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
        version,
        codeSignature: resolveCurrentDaemonCodeSignature(),
        processStartTime,
      })}\n`,
      'utf8',
    );
    probeAnswers.length = 0;
    probedPorts.length = 0;
    mockEmitDiagnostic.mockClear();
    await body({ stateDir, pid });
  } finally {
    mockMissNextProbe.value = false;
    mockSpawnDaemon.mockReset();
    mockReadProcessStartTime.mockReset();
    mockReadProcessCommand.mockReset();
    await closeLoopbackServer(server);
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
      await waitForProcessExit(pid, 1_500);
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function sendSmoke(stateDir: string) {
  return sendToDaemon({
    session: 'default',
    command: 'stalled-probe-smoke',
    positionals: [],
    flags: { stateDir, daemonTransport: 'socket' },
    meta: { requestId: 'req-stalled-probe' },
  });
}

test('sendToDaemon keeps a live daemon whose first probe missed', async (t) => {
  await withLiveStandIn(t, readVersion(), async ({ stateDir, pid }) => {
    mockMissNextProbe.value = true;

    const response = await sendSmoke(stateDir);

    assert.deepEqual(probeAnswers.slice(0, 2), [false, true]);
    assert.deepEqual(response, { ok: true, data: { via: 'live-daemon' } });
    assert.equal(isProcessAlive(pid), true);
    assert.ok(
      mockEmitDiagnostic.mock.calls.some(
        ([event]) => event.phase === 'daemon_probe_recovered' && event.data?.pid === pid,
      ),
      'a recovered probe names the daemon it kept',
    );
  });
});

test('sendToDaemon refuses a live newer daemon whose first probe missed', async (t) => {
  await withLiveStandIn(t, NEWER_DAEMON_VERSION, async ({ stateDir, pid }) => {
    mockMissNextProbe.value = true;

    await assert.rejects(
      () => sendSmoke(stateDir),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.daemonVersion, NEWER_DAEMON_VERSION);
        return true;
      },
    );

    assert.deepEqual(probeAnswers.slice(0, 2), [false, true]);
    assert.equal(isProcessAlive(pid), true);
    assert.equal(mockSpawnDaemon.mock.calls.length, 0, 'no replacement daemon is spawned');
  });
});

async function expectDeadDaemonReplaced(
  t: { skip: (reason: string) => void },
  deadVersion: string,
): Promise<void> {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  const stateDir = mkdtempForTestSync('agent-device-dead-probe-');
  const gone = runCmdBackground(process.execPath, ['-e', ''], {
    stdio: 'ignore',
    allowFailure: true,
    captureOutput: false,
  });
  await gone.wait.catch(() => {});
  const deadPid = gone.child.pid;
  assert.ok(deadPid, 'spawned child should have a pid');
  const fresh = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', () => {
      socket.end(`${JSON.stringify({ ok: true, data: { via: 'fresh-daemon' } })}\n`);
    });
  });
  const writeInfo = (port: number, pid: number, version: string) => {
    const paths = resolveDaemonPaths(stateDir);
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(
      paths.infoPath,
      `${JSON.stringify({
        port,
        transport: 'socket',
        token: 'local-secret',
        pid,
        version,
        codeSignature: resolveCurrentDaemonCodeSignature(),
        processStartTime: readProcessStartTime(process.pid) ?? undefined,
      })}\n`,
      'utf8',
    );
  };

  try {
    // Bound before the dead port is picked, so the port the dead daemon recorded cannot be
    // handed back to the fresh one.
    const freshPort = await listenOnLoopback(fresh);
    const unused = net.createServer();
    const deadPort = await listenOnLoopback(unused);
    await closeLoopbackServer(unused);
    writeInfo(deadPort, deadPid, deadVersion);
    mockSpawnDaemon.mockImplementation(() => {
      writeInfo(freshPort, process.pid, readVersion());
      return { pid: process.pid, exited: new Promise(() => {}) };
    });
    probeAnswers.length = 0;
    probedPorts.length = 0;
    mockEmitDiagnostic.mockClear();
    if (isProcessAlive(deadPid)) {
      t.skip('the host recycled the exited stand-in pid before the probe');
      return;
    }

    const response = await sendSmoke(stateDir);

    assert.deepEqual(response, { ok: true, data: { via: 'fresh-daemon' } });
    assert.equal(mockSpawnDaemon.mock.calls.length, 1, 'the dead daemon was replaced');
    const deadProbes = probeAnswers.filter((_, index) => probedPorts[index] === deadPort);
    assert.deepEqual(deadProbes, [false], 'a daemon whose pid is gone gets no patient retry');
    assert.equal(
      mockEmitDiagnostic.mock.calls.some(([event]) => event.phase === 'daemon_probe_recovered'),
      false,
    );
  } finally {
    mockSpawnDaemon.mockReset();
    await closeLoopbackServer(fresh);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test('sendToDaemon replaces a daemon whose process is gone after a single probe', async (t) => {
  await expectDeadDaemonReplaced(t, readVersion());
});

test('sendToDaemon replaces a newer daemon whose process is gone after a single probe', async (t) => {
  await expectDeadDaemonReplaced(t, NEWER_DAEMON_VERSION);
});
