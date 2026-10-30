import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { afterEach, test } from 'vitest';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  supportsLoopbackBind,
} from '@agent-device/test-kit';
import { tryAcquireProcessLock } from '@agent-device/host-kit/file';
import { readRecordedDaemon, sendToRecordedDaemon } from './recorded-daemon.ts';

// `sendToRecordedDaemon` resolves a recorded daemon and sends through the client transport. It must
// keep every guarantee of that transport and none of its lifecycle: nothing is started, replaced or
// retired, whatever the daemon answers.

const REQUEST = { session: 'default', command: 'snapshot', positionals: [] as string[] };
const servers: net.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await closeLoopbackServer(server);
});

async function recordedSocketDaemon(reply: ((line: string) => string | undefined) | 'silent') {
  const stateDir = mkdtempForTestSync('agent-device-recorded-daemon-');
  const received: string[] = [];
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    let buffered = '';
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      if (!buffered.includes('\n')) return;
      received.push(buffered.trim());
      const answer = reply === 'silent' ? undefined : reply(buffered.trim());
      if (answer !== undefined) socket.write(`${answer}\n`);
    });
  });
  servers.push(server);
  const port = await listenOnLoopback(server);
  const paths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    JSON.stringify({ port, token: 'recorded-secret', pid: process.pid, transport: 'socket' }),
  );
  return { stateDir, paths, received, connections: () => connections };
}

const send = (
  stateDir: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): ReturnType<typeof sendToRecordedDaemon> =>
  sendToRecordedDaemon(REQUEST, {
    host: createTestHostEnvironment(),
    stateDir,
    timeoutMs: options.timeoutMs ?? 2_000,
    signal: options.signal,
  });

test('a request goes to the recorded daemon with its token and returns its answer', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const daemon = await recordedSocketDaemon(() => JSON.stringify({ ok: true, data: { n: 1 } }));

  assert.deepEqual(await send(daemon.stateDir), { ok: true, data: { n: 1 } });

  const sent = JSON.parse(daemon.received[0]!) as { token: string; command: string };
  assert.equal(sent.token, 'recorded-secret');
  assert.equal(sent.command, 'snapshot');
});

test('an already-aborted signal dispatches nothing', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const daemon = await recordedSocketDaemon(() => JSON.stringify({ ok: true, data: {} }));
  const controller = new AbortController();
  controller.abort(new Error('caller gave up'));

  await assert.rejects(
    send(daemon.stateDir, { signal: controller.signal }),
    (error: unknown) => isRequestCanceledError(error) && error.details?.dispatched === 'no',
  );

  assert.equal(daemon.connections(), 0);
  assert.deepEqual(daemon.received, []);
});

test('an invalid response rejects with a typed error and leaves the registration alone', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const daemon = await recordedSocketDaemon(() => 'this is not json');

  await assert.rejects(
    send(daemon.stateDir),
    (error: unknown) => error instanceof AppError && error.message === 'Invalid daemon response',
  );

  assert.equal(fs.existsSync(daemon.paths.infoPath), true);
});

test('a timeout rejects without retiring the daemon', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const daemon = await recordedSocketDaemon('silent');

  await assert.rejects(send(daemon.stateDir, { timeoutMs: 100 }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    return true;
  });

  assert.equal(fs.existsSync(daemon.paths.infoPath), true);
  assert.equal(daemon.connections(), 1, 'one attempt, no restart');
});

test('a state directory that records no daemon is reported, not started', async () => {
  const stateDir = mkdtempForTestSync('agent-device-recorded-none-');

  await assert.rejects(
    send(stateDir),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'daemon_not_running' &&
      error.details?.stateDir === stateDir,
  );

  assert.equal(fs.existsSync(resolveDaemonPaths(stateDir).infoPath), false);
});

test('record admission requires a token and a usable endpoint', () => {
  const dir = mkdtempForTestSync('record-validation-');
  const file = resolveDaemonPaths(dir).infoPath;
  for (const [record, valid] of [
    [{ pid: 1, token: '', port: 1 }, false],
    [{ pid: 1, token: 'x' }, false],
    [{ pid: 1, token: 'x', port: -1 }, false],
    [{ pid: 1, token: 'x', httpPort: 65536 }, false],
    [{ pid: 1, token: 'x', port: 1234, transport: 'socket' }, true],
    [{ pid: 1, token: 'x', httpPort: 1234, transport: 'http' }, true],
  ] as const) {
    fs.writeFileSync(file, JSON.stringify(record));
    assert.equal(readRecordedDaemon(file) !== null, valid, JSON.stringify(record));
  }
});

test('recorded daemon requires a matching held registration claim', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const daemon = await recordedSocketDaemon(() => JSON.stringify({ ok: true, data: {} }));
  const owner = { pid: process.pid, startTime: 'recorded-start', acquiredAtMs: Date.now() };
  const lock = tryAcquireProcessLock({ lockDirPath: daemon.paths.lockPath, owner });
  assert.equal(lock.status, 'acquired');
  if (lock.status !== 'acquired') return;
  try {
    await assert.rejects(
      send(daemon.stateDir),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'daemon_registration_unproven',
    );
    const record = JSON.parse(fs.readFileSync(daemon.paths.infoPath, 'utf8'));
    fs.writeFileSync(
      daemon.paths.infoPath,
      JSON.stringify({ ...record, processStartTime: 'other' }),
    );
    await assert.rejects(
      send(daemon.stateDir),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'daemon_registration_unproven',
    );
    fs.writeFileSync(
      daemon.paths.infoPath,
      JSON.stringify({ ...record, processStartTime: owner.startTime }),
    );
    assert.equal((await send(daemon.stateDir)).ok, true);
  } finally {
    await lock.acquisition.release();
  }
});

test('dual transport tries its recorded socket before HTTP', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const daemon = await recordedSocketDaemon(() =>
    JSON.stringify({ ok: true, data: { via: 'socket' } }),
  );
  let httpConnections = 0;
  const http = net.createServer((socket) => {
    httpConnections++;
    socket.destroy();
  });
  servers.push(http);
  const httpPort = await listenOnLoopback(http);
  const record = JSON.parse(fs.readFileSync(daemon.paths.infoPath, 'utf8'));
  fs.writeFileSync(
    daemon.paths.infoPath,
    JSON.stringify({ ...record, httpPort, transport: 'dual' }),
  );
  assert.deepEqual(await send(daemon.stateDir), { ok: true, data: { via: 'socket' } });
  assert.equal(httpConnections, 0);
});

test('a publishing registration cannot be used', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const daemon = await recordedSocketDaemon(() => JSON.stringify({ ok: true, data: {} }));
  fs.writeFileSync(daemon.paths.lockPath.replace(/\.lock$/, '.reclaim.lock'), '');
  await assert.rejects(
    send(daemon.stateDir),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'daemon_registration_unproven',
  );
  assert.equal(daemon.connections(), 0);
});
