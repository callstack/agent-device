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

// The spawned stand-in's identity is read once and pinned: a second real `ps` can miss its
// deadline under suite load and misclassify the live process as gone.
const { mockReadProcessStartTime, mockReadProcessCommand } = vi.hoisted(() => ({
  mockReadProcessStartTime: vi.fn<(pid: number) => string | null | undefined>(),
  mockReadProcessCommand: vi.fn<(pid: number) => string | null | undefined>(),
}));

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

/** Blocks the event loop right after the first socket arms its timeout, as a loaded client does. */
function stallAfterFirstProbeArms(): { stalled: () => boolean; restore: () => void } {
  const originalCreateConnection = net.createConnection;
  let stalled = false;
  (net as unknown as { createConnection: typeof net.createConnection }).createConnection = ((
    ...args: Parameters<typeof net.createConnection>
  ) => {
    const socket = originalCreateConnection(...args);
    if (stalled) return socket;
    stalled = true;
    const armTimeout = socket.setTimeout.bind(socket);
    socket.setTimeout = ((timeoutMs: number) => {
      armTimeout(timeoutMs);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
      return socket;
    }) as typeof socket.setTimeout;
    return socket;
  }) as typeof net.createConnection;
  return {
    stalled: () => stalled,
    restore: () => {
      (net as unknown as { createConnection: typeof net.createConnection }).createConnection =
        originalCreateConnection;
    },
  };
}

test('sendToDaemon keeps a live socket daemon whose probe the client stalled past', async (t) => {
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
  let stall: ReturnType<typeof stallAfterFirstProbeArms> | undefined;

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
        version: readVersion(),
        codeSignature: resolveCurrentDaemonCodeSignature(),
        processStartTime,
      })}\n`,
      'utf8',
    );
    stall = stallAfterFirstProbeArms();

    const response = await sendToDaemon({
      session: 'default',
      command: 'stalled-probe-smoke',
      positionals: [],
      flags: { stateDir, daemonTransport: 'socket' },
      meta: { requestId: 'req-stalled-probe' },
    });

    assert.equal(stall.stalled(), true);
    assert.deepEqual(response, { ok: true, data: { via: 'live-daemon' } });
    assert.equal(isProcessAlive(pid), true);
  } finally {
    stall?.restore();
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
});
