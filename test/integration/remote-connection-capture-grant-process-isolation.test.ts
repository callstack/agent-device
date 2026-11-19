import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { DAEMON_RPC_PROTOCOL_VERSION } from '@agent-device/contracts/daemon-http';
import { runSourceCliJson } from './cli-json.ts';

// #4518 benign fixture proof, true two-process form: a remote `record start` persists its
// caller-named destination in the shared state directory BEFORE dispatch; an accepted start
// whose answer is withheld still authorizes a later `record stop` run as a SEPARATE CLI process
// from a DIFFERENT working directory — but only because the daemon echoes the grant ID back and
// the persisted record matches it with the full scope. An echoed ID that matches nothing (or no
// echo at all) leaves only the contained cwd-local name, a successful matching stop deletes the
// grant, a failed or errored answer retains it, and a confirmed close retires the session's
// grants. Loopback fixture daemon only: no devices, no real user paths, no hostile payloads —
// this proves the benign cross-process flow, not a security exposure.

const VIDEO_BYTES = 'video-bytes';
const UNMATCHED_GRANT_ID = '00000000-0000-4000-8000-000000000000';

type GrantRecord = {
  grantId: string;
  destination: string;
};

type FixtureStart = { grantId?: string; outPath?: string };
type FixtureStopMode = 'echo' | 'unmatched' | 'error';

function writeFixtureStop(
  writeJson: (statusCode: number, payload: unknown) => void,
  id: unknown,
  start: FixtureStart | undefined,
  mode: FixtureStopMode,
): void {
  if (mode === 'error') {
    writeJson(200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: 'fixture stop failure', data: {} },
    });
    return;
  }
  const captureGrantId = mode === 'unmatched' ? UNMATCHED_GRANT_ID : start?.grantId;
  const localPath = start?.outPath ? `${start.outPath}.mp4` : '/daemon/x.mp4';
  writeJson(200, {
    jsonrpc: '2.0',
    id,
    result: {
      ok: true,
      data: {
        outPath: localPath,
        captureGrantId,
        artifacts: [
          {
            artifactId: 'rec-1',
            path: '/daemon/rec-1',
            fileName: 'demo.mp4',
            field: 'outPath',
            localPath,
            captureGrantId,
          },
        ],
      },
    },
  });
}

type FakeDaemon = {
  server: http.Server;
  port: number;
  starts: FixtureStart[];
  setStopMode(mode: FixtureStopMode): void;
  setCloseMode(mode: 'ok' | 'error'): void;
};

function createFakeDaemon(): FakeDaemon {
  const starts: FixtureStart[] = [];
  let stopMode: FixtureStopMode = 'echo';
  let closeMode: 'ok' | 'error' = 'ok';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://loopback');
    const writeJson = (statusCode: number, payload: unknown) => {
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && url.pathname === '/agent-device/health') {
      writeJson(200, {
        ok: true,
        service: 'agent-device-daemon',
        version: '0.0.0-test',
        rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/agent-device/artifacts/')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(VIDEO_BYTES);
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/agent-device/rpc') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const payload = JSON.parse(body) as {
        id: unknown;
        method?: string;
        params?: {
          command?: string;
          positionals?: unknown[];
          meta?: { captureGrantId?: string; clientArtifactPaths?: Record<string, string> };
        };
      };
      const params = payload.params ?? {};
      const lease = {
        leaseId: 'lease-1',
        tenantId: 'browserstack',
        runId: 'capture-grant-fixture',
        backend: 'ios-instance',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (
        payload.method === 'agent_device.lease.allocate' ||
        payload.method === 'agent_device.lease.heartbeat'
      ) {
        writeJson(200, { jsonrpc: '2.0', id: payload.id, result: { ok: true, data: { lease } } });
        return;
      }
      if (payload.method === 'agent_device.lease.release') {
        writeJson(200, { jsonrpc: '2.0', id: payload.id, result: { ok: true, data: {} } });
        return;
      }
      if (params.command === 'record' && params.positionals?.[0] === 'start') {
        starts.push({
          grantId: params.meta?.captureGrantId,
          outPath: params.meta?.clientArtifactPaths?.outPath,
        });
        req.socket.destroy();
        return;
      }
      if (params.command === 'record' && params.positionals?.[0] === 'stop') {
        writeFixtureStop(writeJson, payload.id, starts.at(-1), stopMode);
        return;
      }
      if (params.command === 'close' && closeMode === 'error') {
        writeJson(200, {
          jsonrpc: '2.0',
          id: payload.id,
          error: { code: -32000, message: 'fixture close failure', data: {} },
        });
        return;
      }
      writeJson(200, { jsonrpc: '2.0', id: payload.id, result: { ok: true, data: {} } });
    });
  });
  return {
    server,
    port: 0,
    starts,
    setStopMode: (mode) => {
      stopMode = mode;
    },
    setCloseMode: (mode) => {
      closeMode = mode;
    },
  };
}

function writeWorld(prefix: string) {
  const root = fs.realpathSync(mkdtempForTestSync(prefix));
  const stateDir = path.join(root, 'state');
  const cwdA = path.join(root, 'project-a');
  const cwdB = path.join(root, 'project-b');
  const home = path.join(root, 'home');
  for (const dir of [cwdA, cwdB, home]) fs.mkdirSync(dir, { recursive: true });
  return { root, stateDir, cwdA, cwdB, home };
}

function writeRemoteConfig(world: { root: string; port: number }): string {
  const configPath = path.join(world.root, 'remote.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      daemonBaseUrl: `http://127.0.0.1:${world.port}/agent-device`,
      daemonTransport: 'http',
      daemonAuthToken: 'fixture-token',
      tenant: 'browserstack',
      runId: 'capture-grant-fixture',
      sessionIsolation: 'tenant',
      platform: 'ios',
      device: 'iPhone 15 Pro',
      providerOsVersion: '17',
    })}\n`,
  );
  return configPath;
}

function readGrantRecords(stateDir: string): GrantRecord[] {
  const dir = path.join(stateDir, 'remote-connections', 'capture-grants');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as GrantRecord);
}

test('a withheld accepted record start still authorizes an exact stop from a separate CLI process in a different cwd', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant two-process proof')) return;
  const world = writeWorld('agent-device-capture-grant-two-process-');
  const daemon = createFakeDaemon();
  try {
    daemon.port = await listenOnLoopback(daemon.server);
    const configPath = writeRemoteConfig({ root: world.root, port: daemon.port });
    const base = [
      '--remote-config',
      configPath,
      '--state-dir',
      world.stateDir,
      '--session',
      'default',
      '--json',
    ];
    const env = { HOME: world.home, USERPROFILE: world.home, CI: '1' };

    // Process 1, cwd A: the start is accepted but its answer is withheld.
    const start = await runSourceCliJson(['record', 'start', 'clips/demo', ...base], {
      cwd: world.cwdA,
      env,
    });
    assert.notEqual(start.status, 0, 'a withheld start answer cannot succeed');
    const granted = path.join(world.cwdA, 'clips', 'demo');
    assert.equal(daemon.starts.length, 1);
    assert.equal(daemon.starts[0]?.outPath, granted);

    // The grant is durable in the shared state before any answer existed.
    const open = readGrantRecords(world.stateDir);
    assert.equal(open.length, 1);
    const openRecord = open.at(0);
    assert.ok(openRecord);
    assert.equal(openRecord.destination, granted);
    assert.equal(openRecord.grantId, daemon.starts[0]?.grantId);

    // Process 2, cwd B, same state: the daemon echoes the grant ID from the accepted capture.
    daemon.setStopMode('echo');
    const stop = await runSourceCliJson(['record', 'stop', ...base], { cwd: world.cwdB, env });
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);
    const outPath = stop.json?.data?.outPath;
    assert.equal(outPath, `${granted}.mp4`);
    assert.equal(stop.json?.data?.captureGrantId, daemon.starts[0]?.grantId);
    assert.equal(fs.readFileSync(`${granted}.mp4`, 'utf8'), VIDEO_BYTES);
    // Nothing landed in the stop process's own cwd.
    assert.deepEqual(fs.readdirSync(world.cwdB), []);
    // The successful matching stop deleted the grant: it never outlives its capture.
    assert.equal(readGrantRecords(world.stateDir).length, 0);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

test('a stop echoing an unmatched grant ID is refused to the contained cwd-local name in the stopping process', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant refusal proof')) return;
  const world = writeWorld('agent-device-capture-grant-refusal-');
  const daemon = createFakeDaemon();
  try {
    daemon.port = await listenOnLoopback(daemon.server);
    const configPath = writeRemoteConfig({ root: world.root, port: daemon.port });
    const base = [
      '--remote-config',
      configPath,
      '--state-dir',
      world.stateDir,
      '--session',
      'default',
      '--json',
    ];
    const env = { HOME: world.home, USERPROFILE: world.home, CI: '1' };

    const start = await runSourceCliJson(['record', 'start', 'clips/demo', ...base], {
      cwd: world.cwdA,
      env,
    });
    assert.notEqual(start.status, 0);
    const granted = path.join(world.cwdA, 'clips', 'demo');
    assert.equal(readGrantRecords(world.stateDir).length, 1);

    // The stop's echo names a grant this client never persisted: no persisted destination is
    // authorized, so the artifact keeps the contained name in the STOP process's cwd.
    daemon.setStopMode('unmatched');
    const stop = await runSourceCliJson(['record', 'stop', ...base], { cwd: world.cwdB, env });
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);
    assert.equal(stop.json?.data?.outPath, path.join(world.cwdB, 'demo.mp4'));
    assert.equal(fs.readFileSync(path.join(world.cwdB, 'demo.mp4'), 'utf8'), VIDEO_BYTES);
    assert.equal(fs.existsSync(`${granted}.mp4`), false);
    // An unmatched echo releases nothing: the grant is retained.
    assert.equal(readGrantRecords(world.stateDir).length, 1);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

test('an error answer to the stop retains the grant instead of guessing an outcome', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant recovery proof')) return;
  const world = writeWorld('agent-device-capture-grant-recovery-');
  const daemon = createFakeDaemon();
  try {
    daemon.port = await listenOnLoopback(daemon.server);
    const configPath = writeRemoteConfig({ root: world.root, port: daemon.port });
    const base = [
      '--remote-config',
      configPath,
      '--state-dir',
      world.stateDir,
      '--session',
      'default',
      '--json',
    ];
    const env = { HOME: world.home, USERPROFILE: world.home, CI: '1' };

    const start = await runSourceCliJson(['record', 'start', 'clips/demo', ...base], {
      cwd: world.cwdA,
      env,
    });
    assert.notEqual(start.status, 0);
    assert.equal(readGrantRecords(world.stateDir).length, 1);

    daemon.setStopMode('error');
    const stop = await runSourceCliJson(['record', 'stop', ...base], { cwd: world.cwdB, env });
    assert.notEqual(stop.status, 0, 'the fixture stop failure must surface');
    // The unbound error names no grant and settles nothing: the record is retained (and the
    // store's stale sweep still bounds it).
    assert.equal(readGrantRecords(world.stateDir).length, 1);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

test('a confirmed close retires the session scope’s grants; a failed close retires nothing', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant close proof')) return;
  const world = writeWorld('agent-device-capture-grant-close-');
  const daemon = createFakeDaemon();
  try {
    daemon.port = await listenOnLoopback(daemon.server);
    const configPath = writeRemoteConfig({ root: world.root, port: daemon.port });
    const base = [
      '--remote-config',
      configPath,
      '--state-dir',
      world.stateDir,
      '--session',
      'default',
      '--json',
    ];
    const env = { HOME: world.home, USERPROFILE: world.home, CI: '1' };

    const start = await runSourceCliJson(['record', 'start', 'clips/demo', ...base], {
      cwd: world.cwdA,
      env,
    });
    assert.notEqual(start.status, 0);
    assert.equal(readGrantRecords(world.stateDir).length, 1);

    // A close the daemon rejects retires nothing.
    daemon.setCloseMode('error');
    const failedClose = await runSourceCliJson(['close', ...base], { cwd: world.cwdA, env });
    assert.notEqual(failedClose.status, 0, 'the fixture close failure must surface');
    assert.equal(readGrantRecords(world.stateDir).length, 1);

    // A close the daemon confirms retires the session's grant records.
    daemon.setCloseMode('ok');
    const close = await runSourceCliJson(['close', ...base], { cwd: world.cwdA, env });
    assert.equal(close.status, 0, close.stderr || close.stdout);
    assert.equal(readGrantRecords(world.stateDir).length, 0);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});
