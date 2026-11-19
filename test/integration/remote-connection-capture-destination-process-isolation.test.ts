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

// #4518, two-process form: a remote `record start` saves its caller-named destination in the
// shared state directory before dispatch. An accepted start whose answer is withheld still lets a
// later `record stop`, run as a separate CLI process from a different cwd, write a daemon
// `localPath` derived from that destination. A `localPath` outside the saved derivations lands in
// the stopping process's cwd. A delivered stop retires the record, a failed stop keeps it, and a
// confirmed close retires the session's records. Loopback fixture daemon only.

const VIDEO_BYTES = 'video-bytes';

type FixtureStart = { outPath?: string };
type FixtureStopMode = 'echo' | 'outside' | 'error';

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
  const outPath = start?.outPath ?? '/daemon/x';
  const localPath = mode === 'outside' ? `${path.dirname(outPath)}/outside.mp4` : `${outPath}.mp4`;
  writeJson(200, {
    jsonrpc: '2.0',
    id,
    result: {
      ok: true,
      data: {
        outPath: localPath,
        artifacts: [
          {
            artifactId: 'rec-1',
            path: '/daemon/rec-1',
            fileName: 'demo.mp4',
            field: 'outPath',
            localPath,
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
          meta?: { clientArtifactPaths?: Record<string, string> };
        };
      };
      const params = payload.params ?? {};
      const lease = {
        leaseId: 'lease-1',
        tenantId: 'browserstack',
        runId: 'capture-destination-fixture',
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
        starts.push({ outPath: params.meta?.clientArtifactPaths?.outPath });
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
      runId: 'capture-destination-fixture',
      sessionIsolation: 'tenant',
      platform: 'ios',
      device: 'iPhone 15 Pro',
      providerOsVersion: '17',
    })}\n`,
  );
  return configPath;
}

function readSavedDestinations(stateDir: string): string[] {
  const dir = path.join(stateDir, 'remote-connections', 'capture-destinations');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) =>
      (
        JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Array<{ destination: string }>
      ).map((record) => record.destination),
    );
}

test('a withheld accepted record start still authorizes an exact stop from a separate CLI process in a different cwd', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture destination two-process proof')) return;
  const world = writeWorld('agent-device-capture-destination-two-process-');
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

    // The destination is durable in the shared state before any answer existed.
    assert.deepEqual(readSavedDestinations(world.stateDir), [granted]);

    // Process 2, cwd B, same state: the daemon returns a derivation of the saved destination.
    daemon.setStopMode('echo');
    const stop = await runSourceCliJson(['record', 'stop', ...base], { cwd: world.cwdB, env });
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);
    const outPath = stop.json?.data?.outPath;
    assert.equal(outPath, `${granted}.mp4`);
    assert.equal(fs.readFileSync(`${granted}.mp4`, 'utf8'), VIDEO_BYTES);
    // Nothing landed in the stop process's own cwd.
    assert.deepEqual(fs.readdirSync(world.cwdB), []);
    // The delivered stop retired the saved destination.
    assert.deepEqual(readSavedDestinations(world.stateDir), []);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

test('a stop localPath outside the saved derivations is refused to the contained cwd-local name in the stopping process', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture destination refusal proof')) return;
  const world = writeWorld('agent-device-capture-destination-refusal-');
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
    assert.deepEqual(readSavedDestinations(world.stateDir), [granted]);

    // The daemon names a path this client never saved, so the artifact keeps the contained name
    // in the STOP process's cwd.
    daemon.setStopMode('outside');
    const stop = await runSourceCliJson(['record', 'stop', ...base], { cwd: world.cwdB, env });
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);
    assert.equal(stop.json?.data?.outPath, path.join(world.cwdB, 'demo.mp4'));
    assert.equal(fs.readFileSync(path.join(world.cwdB, 'demo.mp4'), 'utf8'), VIDEO_BYTES);
    assert.equal(fs.existsSync(path.join(world.cwdA, 'clips', 'outside.mp4')), false);
    // A refused path uses no saved destination, so it is retained.
    assert.deepEqual(readSavedDestinations(world.stateDir), [granted]);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

test('an error answer to the stop retains the saved destination instead of guessing an outcome', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture destination recovery proof')) return;
  const world = writeWorld('agent-device-capture-destination-recovery-');
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
    assert.equal(readSavedDestinations(world.stateDir).length, 1);

    daemon.setStopMode('error');
    const stop = await runSourceCliJson(['record', 'stop', ...base], { cwd: world.cwdB, env });
    assert.notEqual(stop.status, 0, 'the fixture stop failure must surface');
    // The error settles nothing: the record is retained until stop, close, or age retires it.
    assert.equal(readSavedDestinations(world.stateDir).length, 1);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

test('a confirmed close retires the session scope’s destinations; a failed close retires nothing', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture destination close proof')) return;
  const world = writeWorld('agent-device-capture-destination-close-');
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
    assert.equal(readSavedDestinations(world.stateDir).length, 1);

    // A close the daemon rejects retires nothing.
    daemon.setCloseMode('error');
    const failedClose = await runSourceCliJson(['close', ...base], { cwd: world.cwdA, env });
    assert.notEqual(failedClose.status, 0, 'the fixture close failure must surface');
    assert.equal(readSavedDestinations(world.stateDir).length, 1);

    // A close the daemon confirms retires the session's saved destinations.
    daemon.setCloseMode('ok');
    const close = await runSourceCliJson(['close', ...base], { cwd: world.cwdA, env });
    assert.equal(close.status, 0, close.stderr || close.stdout);
    assert.equal(readSavedDestinations(world.stateDir).length, 0);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});
