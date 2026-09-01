import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import { resolveDaemonPaths } from '../daemon/config.ts';
import { startDaemonRuntime } from '../daemon/server/daemon-runtime.ts';
import {
  cleanupDownloadableArtifact,
  trackDownloadableArtifact,
} from '../daemon/artifact-tracking.ts';
import { runCmdBackground } from '@agent-device/host-kit/command';
import {
  createOwnedProcessRecordStore,
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  waitForProcessExit,
} from '@agent-device/host-kit/process';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { screenRecordingDurableResource } from '../daemon/screen-recording-session-resource.ts';

import { closeLoopbackServer, listenOnLoopback, waitForHttpOk } from './test-utils/loopback.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

type DaemonInfoFile = {
  httpPort?: number;
  transport?: string;
  token?: string;
  pid?: number;
};

function waitForStdoutLine(
  stream: NodeJS.ReadableStream | null,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  if (!stream) {
    return Promise.reject(new Error('Expected daemon stdout stream.'));
  }
  stream.setEncoding('utf8');
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for daemon stdout line matching ${pattern}.`));
    }, timeoutMs);
    const onData = (chunk: string) => {
      buffer += chunk;
      const line = buffer
        .split('\n')
        .map((entry) => entry.trim())
        .find((entry) => pattern.test(entry));
      if (!line) return;
      cleanup();
      resolve(line);
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off('data', onData);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

test('daemon runtime starts HTTP transport in-process and shuts down cleanly', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-runtime-');
  const paths = resolveDaemonPaths(stateDir);
  const artifactPath = path.join(stateDir, 'runtime-artifact.txt');
  fs.writeFileSync(artifactPath, 'runtime-artifact');
  const artifactId = trackDownloadableArtifact({
    artifactPath,
    artifactType: 'runtime-artifact',
    fileName: 'runtime-artifact.txt',
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;

  try {
    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_RETAIN_ARTIFACTS: '1',
      },
      exit: (code) => {
        exitCode = code;
      },
      registerProcessHandlers: false,
      stderr: { write: (chunk) => stderr.push(chunk) },
      stdout: { write: (chunk) => stdout.push(chunk) },
    });

    assert.notEqual(runtime, null);
    assert.equal(typeof runtime?.httpPort, 'number');
    assert.equal(runtime?.socketPort, undefined);
    assert.match(stdout.join(''), /^AGENT_DEVICE_DAEMON_HTTP_PORT=\d+\n$/);
    assert.deepEqual(stderr, []);

    const info = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as DaemonInfoFile;
    assert.equal(info.httpPort, runtime?.httpPort);
    assert.equal(info.transport, 'http');
    assert.equal(info.token, runtime?.token);
    assert.ok(fs.existsSync(paths.lockPath), 'daemon lock should be held while runtime is active');

    await waitForHttpOk(`http://127.0.0.1:${runtime?.httpPort}/health`, 2_000);
    const artifactResponse = await fetch(
      `http://127.0.0.1:${runtime?.httpPort}/artifacts/${encodeURIComponent(artifactId)}`,
      {
        headers: {
          authorization: `Bearer ${runtime?.token}`,
          connection: 'close',
        },
      },
    );
    assert.equal(artifactResponse.status, 200);
    assert.equal(await artifactResponse.text(), 'runtime-artifact');
    assert.equal(fs.existsSync(artifactPath), true);

    await runtime?.shutdown();

    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    cleanupDownloadableArtifact(artifactId);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon runtime publishes dual transport metadata', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-runtime-dual-');
  const paths = resolveDaemonPaths(stateDir);
  const stdout: string[] = [];
  let exitCode: number | undefined;

  try {
    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'dual',
      },
      exit: (code) => {
        exitCode = code;
      },
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: (chunk) => stdout.push(chunk) },
    });

    assert.notEqual(runtime, null);
    assert.equal(typeof runtime?.httpPort, 'number');
    assert.equal(typeof runtime?.socketPort, 'number');
    assert.match(stdout.join(''), /AGENT_DEVICE_DAEMON_PORT=\d+/);
    assert.match(stdout.join(''), /AGENT_DEVICE_DAEMON_HTTP_PORT=\d+/);

    const info = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as DaemonInfoFile;
    assert.equal(info.httpPort, runtime?.httpPort);
    assert.equal(info.transport, 'dual');

    await waitForHttpOk(`http://127.0.0.1:${runtime?.httpPort}/health`, 2_000);
    await runtime?.shutdown();

    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon rejects unowned cloud artifacts over RPC', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-provider-');
  const providerRequests: string[] = [];
  const providerServer = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        automation_session: { video_url: 'https://browserstack.example/video.mp4' },
      }),
    );
  });
  const providerPort = await listenOnLoopback(providerServer);
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> = null;

  try {
    runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        BROWSERSTACK_USERNAME: 'user',
        BROWSERSTACK_ACCESS_KEY: 'key',
        BROWSERSTACK_SESSION_DETAILS_ENDPOINT: `http://127.0.0.1:${providerPort}/sessions`,
      },
      exit: () => {},
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    assert.ok(runtime?.httpPort);

    const response = await fetch(`http://127.0.0.1:${runtime.httpPort}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'cloud-artifacts',
        method: 'agent_device.command',
        params: {
          token: runtime.token,
          session: 'default',
          command: 'artifacts',
          positionals: [],
          flags: { provider: 'browserstack', providerSessionId: 'wd-1' },
        },
      }),
    });
    const body = (await response.json()) as {
      error?: { code?: number; message?: string; data?: { code?: string; details?: unknown } };
    };

    assert.equal(response.status, 401);
    assert.equal(body.error?.code, -32000);
    assert.equal(body.error?.data?.code, 'UNAUTHORIZED');
    assert.deepEqual(body.error?.data?.details, { reason: 'PROVIDER_SESSION_NOT_OWNED' });
    assert.deepEqual(providerRequests, []);
  } finally {
    await runtime?.shutdown();
    await closeLoopbackServer(providerServer);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon entrypoint publishes HTTP metadata and cleans up on shutdown', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-entrypoint-');
  const paths = resolveDaemonPaths(stateDir);
  const daemon = runCmdBackground(
    process.execPath,
    ['--experimental-strip-types', 'src/daemon.ts'],
    {
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
      allowFailure: true,
    },
  );
  const pid = daemon.child.pid;
  assert.ok(pid, 'daemon process should have a pid');

  try {
    const portLine = await waitForStdoutLine(
      daemon.child.stdout,
      /^AGENT_DEVICE_DAEMON_HTTP_PORT=\d+$/,
      5_000,
    );
    const httpPort = Number(portLine.split('=')[1]);
    const info = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as DaemonInfoFile;

    assert.equal(info.httpPort, httpPort);
    assert.equal(info.pid, pid);
    assert.equal(typeof info.token, 'string');
    assert.ok(fs.existsSync(paths.lockPath), 'daemon lock should be held while running');

    await waitForHttpOk(`http://127.0.0.1:${httpPort}/health`, 2_000);

    daemon.child.kill('SIGTERM');
    const exited = await waitForProcessExit(pid, 5_000);
    assert.equal(exited, true);
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    if (isProcessAlive(pid)) {
      daemon.child.kill('SIGKILL');
      await waitForProcessExit(pid, 2_000);
    }
    await daemon.wait.catch(() => {});
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon runtime records startup device-claim reconciliation in daemon.log', async () => {
  // Regression: reconciliation ran before publishDaemonInfo, which truncates
  // daemon.log — so the event was written and then wiped, leaving nothing in
  // the log users are told to inspect. Asserted against a real runtime start
  // rather than reconciliation in isolation, since the ordering is the bug.
  const stateDir = mkdtempForTestSync('agent-device-daemon-prune-log-');
  const claimsDir = mkdtempForTestSync('agent-device-daemon-prune-claims-');
  const paths = resolveDaemonPaths(stateDir);
  const deviceKey = 'local:android:none:prune-log';
  // resolveDeviceClaimRoot reads process.env directly, not the env passed to
  // startDaemonRuntime, so the store has to be redirected on the process.
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  let exitCode: number | undefined;

  try {
    fs.writeFileSync(
      path.join(claimsDir, `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey,
        device: { platform: 'android', id: 'prune-log', name: 'Prune Log', kind: 'emulator' },
        session: 'dead-session',
        workspace: '/worktrees/dead',
        stateDir: process.cwd(),
        ownerPid: 999_999_999,
        ownerStartTime: 'old-start-time',
        ownerToken: 'dead-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );

    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_CLAIMS_DIR: claimsDir,
      },
      exit: (code) => {
        exitCode = code;
      },
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });

    assert.notEqual(runtime, null);
    assert.deepEqual(fs.readdirSync(claimsDir), [], 'the dead claim should be reconciled');

    const log = fs.readFileSync(paths.logPath, 'utf8');
    assert.match(log, /"phase":"device_claim_reconcile"/);
    assert.match(log, /"reconciled":1/);

    await runtime?.shutdown();
    assert.equal(exitCode, 0);
  } finally {
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

test('startup sweep settles a foreign dead owner without touching a live same-named session', async () => {
  // #2168: the sweep must compose recovery from the STALE CLAIM's state dir.
  // With the daemon-gateway (caller-scoped) reconciler this test goes red: the
  // foreign recording cleanup clears session "shared" in THIS daemon's store,
  // deleting the live record planted below, and leaves the foreign one behind.
  const daemonStateDir = mkdtempForTestSync('agent-device-daemon-sweep-scope-');
  const foreignStateDir = mkdtempForTestSync('agent-device-daemon-sweep-foreign-');
  const claimsDir = mkdtempForTestSync('agent-device-daemon-sweep-claims-');
  const deviceId = 'sweep-scope-udid';
  const deviceKey = `local:apple:ios:${deviceId}`;
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;

  const sessionStoreFor = (stateDir: string) => {
    const paths = resolveDaemonPaths(stateDir);
    return createOwnedProcessRecordStore({
      stateDir: paths.baseDir,
      sessionsDir: paths.sessionsDir,
      resolveSessionDir: (sessionId) => path.join(paths.sessionsDir, sessionId),
    });
  };

  // The dead owner's recorded recorder, still running as an orphan: recovery
  // must find it owned-alive so it takes the descriptor-cleanup path, which
  // terminates it and clears the owner's process record — through whichever
  // owned-process store the sweep composed. A plain sleeper with its real
  // observed command and start time satisfies the exact-identity match.
  const orphanRecorder = spawn('sleep', ['120'], { stdio: 'ignore' });
  await new Promise((resolve) => orphanRecorder.once('spawn', resolve));
  const orphanPid = orphanRecorder.pid;
  assert.ok(orphanPid);
  const orphanMarker = {
    pid: orphanPid,
    startTime: readProcessStartTime(orphanPid) ?? '',
    command: readProcessCommand(orphanPid) ?? '',
  };
  assert.ok(orphanMarker.startTime.length > 0 && orphanMarker.command.length > 0);
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> = null;

  try {
    const foreignSessionDir = path.join(resolveDaemonPaths(foreignStateDir).sessionsDir, 'shared');
    const resourcePath = screenRecordingDurableResource.store.resolvePath(foreignSessionDir);
    screenRecordingDurableResource.store.write(
      resourcePath,
      createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: 'shared',
        device: { id: deviceId, family: 'apple', appleOs: 'ios', kind: 'simulator' },
        owner: { kind: 'local-family', family: 'apple' },
        fence: { token: 'sweep-fence', generation: 1 },
        lifecycle: 'open',
        descriptor: {
          version: 1,
          body: {
            backend: 'simctl',
            outputPath: path.join(foreignSessionDir, 'recording.mp4'),
            processes: [orphanMarker],
          },
        },
      }),
    );
    sessionStoreFor(foreignStateDir).replace({ kind: 'session', sessionId: 'shared' }, [
      { ...orphanMarker, purpose: 'simctl-screen-recording' },
    ]);
    // The live same-named session in THIS daemon's state dir. The purpose is
    // outside the startup reaper's selection, so only a wrong-store recovery
    // clear can remove it.
    sessionStoreFor(daemonStateDir).replace({ kind: 'session', sessionId: 'shared' }, [
      { pid: process.pid, startTime: 'live-marker', command: 'live-probe', purpose: 'test-probe' },
    ]);
    const liveRecordPath = path.join(
      resolveDaemonPaths(daemonStateDir).sessionsDir,
      'shared',
      'owned-processes.json',
    );
    const liveRecordBefore = fs.readFileSync(liveRecordPath, 'utf8');
    fs.writeFileSync(
      path.join(claimsDir, `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey,
        device: { platform: 'ios', id: deviceId, name: 'Sweep Scope iPhone', kind: 'simulator' },
        session: 'shared',
        workspace: '/worktrees/dead',
        stateDir: foreignStateDir,
        ownerPid: 999_999_999,
        ownerStartTime: 'old-start-time',
        ownerToken: 'sweep-scope-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );

    runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: daemonStateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_CLAIMS_DIR: claimsDir,
      },
      exit: () => {},
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    assert.notEqual(runtime, null);

    assert.deepEqual(fs.readdirSync(claimsDir), [], 'the foreign dead claim should be reconciled');
    const settled = screenRecordingDurableResource.store.read(resourcePath);
    assert.equal(settled.status, 'decoded');
    if (settled.status === 'decoded') {
      assert.equal(settled.envelope.lifecycle, 'completed');
    }
    assert.equal(
      fs.existsSync(path.join(foreignSessionDir, 'owned-processes.json')),
      false,
      "the dead owner's process record should be cleared in the OWNER's state dir",
    );
    assert.equal(
      fs.readFileSync(liveRecordPath, 'utf8'),
      liveRecordBefore,
      "the live same-named session's process record must stay byte-identical",
    );

    assert.equal(
      isProcessAlive(orphanPid),
      false,
      "the dead owner's orphaned recorder should be terminated by recovery",
    );
  } finally {
    await runtime?.shutdown().catch(() => {});
    try {
      orphanRecorder.kill('SIGKILL');
    } catch {}
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(daemonStateDir, { recursive: true, force: true });
    fs.rmSync(foreignStateDir, { recursive: true, force: true });
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});
