import assert from 'node:assert/strict';
import net from 'node:net';
import { afterEach, test, vi } from 'vitest';
import { observeRunnerListener, retainRunnerSession } from '../runner-retention.ts';
import { makeRunnerSession } from './runner-session-fixtures.ts';
import type { RunnerSession } from '../runner-session-types.ts';

const listeners: net.Server[] = [];
const connections: net.Socket[] = [];
const sessions: RunnerSession[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const session of sessions.splice(0)) {
    session.retention?.cancel();
    session.listenerWatch?.close();
  }
  for (const socket of connections.splice(0)) socket.destroy();
  await Promise.all(
    listeners
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function servingSession(): Promise<RunnerSession> {
  const listener = net.createServer((socket) => connections.push(socket));
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  listeners.push(listener);
  const session = makeRunnerSession({
    state: 'ready',
    port: (listener.address() as net.AddressInfo).port,
  });
  sessions.push(session);
  return session;
}

async function observe(session: RunnerSession, onLost = vi.fn()): Promise<void> {
  observeRunnerListener(session, onLost);
  assert.equal(await session.listenerWatch?.ready, true);
  await vi.waitFor(() => assert.ok(connections.length));
}

test('one generation has one listener watch, and loss before close prevents retention', async () => {
  const session = await servingSession();
  const onLost = vi.fn();
  await observe(session, onLost);
  observeRunnerListener(session, onLost);
  assert.equal(connections.length, 1);
  connections[0]!.destroy();
  await vi.waitFor(() => assert.equal(onLost.mock.calls.length, 1));
  assert.equal(await retainRunnerSession(session, vi.fn()), false);
});

test('a refused watch is never attached to a later listener on the same port', async () => {
  const session = await servingSession();
  const listener = listeners.pop()!;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  observeRunnerListener(session, vi.fn());
  assert.equal(await session.listenerWatch?.ready, false);
  const replacement = net.createServer((socket) => connections.push(socket));
  await new Promise<void>((resolve) => replacement.listen(session.port, '127.0.0.1', resolve));
  listeners.push(replacement);
  observeRunnerListener(session, vi.fn());
  assert.equal(await retainRunnerSession(session, vi.fn()), false);
  assert.equal(connections.length, 0);
});

test('the idle timer expires once and cancellation of an old window preserves its replacement', async () => {
  const session = await servingSession();
  await observe(session);
  vi.useFakeTimers();
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS', '40');
  const stop = vi.fn(async () => {});
  await retainRunnerSession(session, stop);
  const previous = session.retention!;
  await vi.advanceTimersByTimeAsync(20);
  await retainRunnerSession(session, stop);
  const current = session.retention;
  previous.cancel();
  assert.equal(session.retention, current);
  await vi.advanceTimersByTimeAsync(39);
  assert.equal(stop.mock.calls.length, 0);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(stop.mock.calls, [[current, 'idle_timeout']]);
});

test('ending retention cancels its idle timer while preserving observation', async () => {
  const session = await servingSession();
  await observe(session);
  vi.useFakeTimers();
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS', '40');
  const stop = vi.fn(async () => {});
  await retainRunnerSession(session, stop);
  session.retention!.cancel();
  await vi.advanceTimersByTimeAsync(40);
  assert.equal(stop.mock.calls.length, 0);
  assert.equal(session.retention, undefined);
  assert.equal(session.listenerWatch?.lost, false);
});

test('zero disables only the idle timer, and unready or occupied generations cannot be retained', async () => {
  const session = await servingSession();
  await observe(session);
  vi.useFakeTimers();
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS', '0');
  const stop = vi.fn(async () => {});
  assert.equal(await retainRunnerSession(session, stop), true);
  await vi.advanceTimersByTimeAsync(600_000);
  assert.equal(stop.mock.calls.length, 0);
  assert.ok(session.retention);
  session.retention!.cancel();
  session.state = 'starting';
  assert.equal(await retainRunnerSession(session, stop), false);
  session.state = 'ready';
  session.runnerMainThreadBusy = true;
  assert.equal(await retainRunnerSession(session, stop), false);
  session.runnerMainThreadBusy = false;
  session.commandCharges.charge('still-in-flight');
  assert.equal(await retainRunnerSession(session, stop), false);
});
