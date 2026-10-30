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
import { sendToRecordedDaemon } from './recorded-daemon.ts';

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
    isRequestCanceledError,
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
    (error: unknown) => error instanceof Error && /No daemon is running/.test(error.message),
  );

  assert.equal(fs.existsSync(resolveDaemonPaths(stateDir).infoPath), false);
});
