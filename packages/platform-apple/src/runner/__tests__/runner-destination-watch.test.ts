import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  attachRunnerDestinationWatch,
  closeRunnerDestinationWatch,
  takeRunnerWarmLossNotice,
} from '../runner-destination-watch.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';

const DEVICE = IOS_SIMULATOR;

type FakeListener = {
  port: number;
  connections: net.Socket[];
  nextConnection(): Promise<net.Socket>;
  close(): Promise<void>;
};

const listeners: FakeListener[] = [];

async function listen(port = 0): Promise<FakeListener> {
  const connections: net.Socket[] = [];
  const waiting: Array<(socket: net.Socket) => void> = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    const waiter = waiting.shift();
    if (waiter) waiter(socket);
    else connections.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const listener: FakeListener = {
    port: (server.address() as net.AddressInfo).port,
    connections,
    nextConnection: () => {
      const queued = connections.shift();
      return queued
        ? Promise.resolve(queued)
        : new Promise<net.Socket>((resolve) => waiting.push(resolve));
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of connections) socket.destroy();
        server.close(() => resolve());
      }),
  };
  listeners.push(listener);
  return listener;
}

async function unusedPort(): Promise<number> {
  const probe = await listen();
  const { port } = probe;
  await probe.close();
  return port;
}

function watchParams(port: number, overrides: { isArmed?: () => boolean } = {}) {
  const onStop = vi.fn(async () => {});
  return {
    onStop,
    params: {
      device: DEVICE,
      sessionId: 'session-1',
      port,
      isArmed: overrides.isArmed ?? (() => true),
      onStop,
    },
  };
}

const realSetTimeout = globalThis.setTimeout;
const realTick = () => new Promise<void>((resolve) => realSetTimeout(resolve, 20));

afterEach(async () => {
  vi.useRealTimers();
  closeRunnerDestinationWatch(DEVICE.id);
  takeRunnerWarmLossNotice(DEVICE.id);
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
});

test('an established connection that closes stops the runner and leaves one notice', async () => {
  const listener = await listen();
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  (await listener.nextConnection()).destroy();
  await vi.waitFor(() => assert.equal(onStop.mock.calls.length, 1));

  assert.ok(takeRunnerWarmLossNotice(DEVICE.id));
  assert.equal(takeRunnerWarmLossNotice(DEVICE.id), undefined);
});

test('a quiet established connection stops nothing', async () => {
  const listener = await listen();
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  await listener.nextConnection();
  await realTick();

  assert.equal(onStop.mock.calls.length, 0);
  assert.equal(takeRunnerWarmLossNotice(DEVICE.id), undefined);
});

test('a close after the retention window ended acts on nothing', async () => {
  const listener = await listen();
  let armed = true;
  const { params, onStop } = watchParams(listener.port, { isArmed: () => armed });

  attachRunnerDestinationWatch(params);
  const connection = await listener.nextConnection();
  armed = false;
  connection.destroy();
  await realTick();

  assert.equal(onStop.mock.calls.length, 0);
  assert.equal(takeRunnerWarmLossNotice(DEVICE.id), undefined);
});

test('closing the watch detaches it so a later runner death stops nothing', async () => {
  const listener = await listen();
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  const connection = await listener.nextConnection();
  closeRunnerDestinationWatch(DEVICE.id);
  connection.destroy();
  await realTick();

  assert.equal(onStop.mock.calls.length, 0);
  assert.equal(takeRunnerWarmLossNotice(DEVICE.id), undefined);
});

test('a second retention window replaces the existing watch instead of stacking another', async () => {
  const listener = await listen();
  const first = watchParams(listener.port);
  const second = watchParams(listener.port);

  attachRunnerDestinationWatch(first.params);
  const firstConnection = await listener.nextConnection();
  attachRunnerDestinationWatch(second.params);
  const secondConnection = await listener.nextConnection();
  firstConnection.destroy();
  await realTick();
  assert.equal(first.onStop.mock.calls.length + second.onStop.mock.calls.length, 0);

  secondConnection.destroy();
  await vi.waitFor(() => assert.equal(second.onStop.mock.calls.length, 1));
  assert.equal(first.onStop.mock.calls.length, 0);
});

test('a refused attach is retried, and a listener that answers keeps the runner', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const port = await unusedPort();
  const { params, onStop } = watchParams(port);

  attachRunnerDestinationWatch(params);
  await realTick();
  const listener = await listen(port);
  await vi.advanceTimersByTimeAsync(1_000);
  const connection = await listener.nextConnection();
  await realTick();

  assert.equal(onStop.mock.calls.length, 0);
  connection.destroy();
  await vi.waitFor(() => assert.equal(onStop.mock.calls.length, 1));
});

test('a port that never answers stops the runner once the retry budget is spent', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { params, onStop } = watchParams(await unusedPort());

  attachRunnerDestinationWatch(params);
  for (let attempt = 0; attempt < 20 && onStop.mock.calls.length === 0; attempt += 1) {
    await realTick();
    await vi.advanceTimersByTimeAsync(1_000);
  }

  assert.equal(onStop.mock.calls.length, 1);
  assert.ok(takeRunnerWarmLossNotice(DEVICE.id));
});

test('a refused attach whose window ended stops retrying', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let armed = true;
  const { params, onStop } = watchParams(await unusedPort(), { isArmed: () => armed });

  attachRunnerDestinationWatch(params);
  await realTick();
  armed = false;
  await vi.advanceTimersByTimeAsync(60_000);

  assert.equal(onStop.mock.calls.length, 0);
  assert.equal(vi.getTimerCount(), 0);
});
