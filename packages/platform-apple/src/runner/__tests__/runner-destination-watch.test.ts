import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  attachRunnerDestinationWatch,
  closeRunnerDestinationWatch,
  takeRunnerWarmLossNotice,
} from '../runner-destination-watch.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';

const DEVICE = IOS_SIMULATOR;
const RUNNER_PID = 4242;

type FakeListener = {
  port: number;
  connections: net.Socket[];
  nextConnection(): Promise<net.Socket>;
  close(): Promise<void>;
};

const listeners: FakeListener[] = [];

async function listen(): Promise<FakeListener> {
  const connections: net.Socket[] = [];
  const waiting: Array<(socket: net.Socket) => void> = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    const waiter = waiting.shift();
    if (waiter) waiter(socket);
    else connections.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
      runnerPid: RUNNER_PID,
      isArmed: overrides.isArmed ?? (() => true),
      onStop,
    },
  };
}

function stubHost(options: {
  boots: Array<{ observed: true; bootedAtMs: number } | { observed: false; reason: 'unobserved' }>;
  processAlive?: boolean;
  state?: string | null;
}) {
  const observeSimulatorBootTimeMs = vi.fn(async () => {
    const next = options.boots.length > 1 ? options.boots.shift() : options.boots[0];
    return next ?? { observed: false as const, reason: 'unobserved' as const };
  });
  appleRunnerTestHost.update({
    observeSimulatorBootTimeMs,
    observeSimulatorState: async () => (options.state === undefined ? 'Booted' : options.state),
    isProcessAlive: () => options.processAlive ?? true,
  });
  return observeSimulatorBootTimeMs;
}

beforeEach(() => {
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_DESTINATION_CONFIRM_MS', '5');
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_DESTINATION_RECHECK_MS', '5');
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_DESTINATION_ATTACH_RETRY_MS', '0');
});

afterEach(async () => {
  closeRunnerDestinationWatch(DEVICE.id);
  takeRunnerWarmLossNotice(DEVICE.id);
  vi.unstubAllEnvs();
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
});

test('an established connection that closes after a newer boot stops the runner with a notice', async () => {
  const listener = await listen();
  stubHost({ boots: [{ observed: true, bootedAtMs: Date.now() + 60_000 }] });
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  (await listener.nextConnection()).destroy();
  await vi.waitFor(() => assert.equal(onStop.mock.calls.length, 1));

  const notice = takeRunnerWarmLossNotice(DEVICE.id);
  assert.equal(notice?.reason, 'runner_destination_lost');
  assert.equal(notice?.sessionId, 'session-1');
  assert.equal(takeRunnerWarmLossNotice(DEVICE.id), undefined);
});

test('a close on the boot the watch was armed on re-arms instead of stopping', async () => {
  const listener = await listen();
  const observe = stubHost({ boots: [{ observed: true, bootedAtMs: Date.now() - 60_000 }] });
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  (await listener.nextConnection()).destroy();
  const replacement = await listener.nextConnection();

  assert.equal(observe.mock.calls.length, 1);
  assert.equal(onStop.mock.calls.length, 0);
  assert.equal(takeRunnerWarmLossNotice(DEVICE.id), undefined);
  replacement.destroy();
});

test('a device listed as shut down is a loss even while its old boot is still observable', async () => {
  const listener = await listen();
  const observe = stubHost({
    boots: [{ observed: true, bootedAtMs: Date.now() - 60_000 }],
    state: 'Shutdown',
  });
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  (await listener.nextConnection()).destroy();
  await vi.waitFor(() => assert.equal(onStop.mock.calls.length, 1));

  assert.equal(observe.mock.calls.length, 0);
  assert.equal(takeRunnerWarmLossNotice(DEVICE.id)?.reason, 'runner_destination_lost');
});

test('a device that is still booting down is a loss, not a crash', async () => {
  const listener = await listen();
  stubHost({
    boots: [{ observed: true, bootedAtMs: Date.now() - 60_000 }],
    state: 'Shutting Down',
  });
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  (await listener.nextConnection()).destroy();
  await vi.waitFor(() => assert.equal(onStop.mock.calls.length, 1));
});

test('an unreadable device state falls back to the boot witness', async () => {
  const listener = await listen();
  stubHost({ boots: [{ observed: true, bootedAtMs: Date.now() - 60_000 }], state: null });
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  (await listener.nextConnection()).destroy();
  const replacement = await listener.nextConnection();

  assert.equal(onStop.mock.calls.length, 0);
  replacement.destroy();
});

test('a boot unobservable on both reads while the destination process lives is a loss', async () => {
  const listener = await listen();
  const observe = stubHost({ boots: [{ observed: false, reason: 'unobserved' }] });
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  (await listener.nextConnection()).destroy();
  await vi.waitFor(() => assert.equal(onStop.mock.calls.length, 1));

  assert.equal(observe.mock.calls.length, 2);
  assert.equal(takeRunnerWarmLossNotice(DEVICE.id)?.reason, 'runner_destination_lost');
});

test('a boot that reappears on the recheck with the armed boot re-arms', async () => {
  const listener = await listen();
  stubHost({
    boots: [
      { observed: false, reason: 'unobserved' },
      { observed: true, bootedAtMs: Date.now() - 60_000 },
    ],
  });
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  (await listener.nextConnection()).destroy();
  const replacement = await listener.nextConnection();

  assert.equal(onStop.mock.calls.length, 0);
  replacement.destroy();
});

test('a dead runner process is plain cleanup without a notice', async () => {
  const listener = await listen();
  const observe = stubHost({ boots: [{ observed: true, bootedAtMs: 0 }], processAlive: false });
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  (await listener.nextConnection()).destroy();
  await vi.waitFor(() => assert.equal(onStop.mock.calls.length, 1));

  assert.equal(observe.mock.calls.length, 0);
  assert.equal(takeRunnerWarmLossNotice(DEVICE.id), undefined);
});

test('a port that never answers is runner_unreachable once the retry budget is spent', async () => {
  stubHost({ boots: [{ observed: true, bootedAtMs: 0 }] });
  const { params, onStop } = watchParams(await unusedPort());

  attachRunnerDestinationWatch(params);
  await vi.waitFor(() => assert.equal(onStop.mock.calls.length, 1));

  assert.equal(takeRunnerWarmLossNotice(DEVICE.id)?.reason, 'runner_unreachable');
});

test('a refused attach whose runner process is gone is silent cleanup', async () => {
  stubHost({ boots: [{ observed: true, bootedAtMs: 0 }], processAlive: false });
  const { params, onStop } = watchParams(await unusedPort());

  attachRunnerDestinationWatch(params);
  await vi.waitFor(() => assert.equal(onStop.mock.calls.length, 1));

  assert.equal(takeRunnerWarmLossNotice(DEVICE.id), undefined);
});

test('a refused attach retries inside its budget and watches the runner once it listens', async () => {
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_DESTINATION_ATTACH_RETRY_MS', '5000');
  const port = await unusedPort();
  // A reboot that began after the window opened but before the retries reached the runner.
  stubHost({ boots: [{ observed: true, bootedAtMs: Date.now() + 20 }] });
  const { params, onStop } = watchParams(port);

  attachRunnerDestinationWatch(params);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(onStop.mock.calls.length, 0);

  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    await vi.waitFor(() => assert.equal(onStop.mock.calls.length, 1), { timeout: 4000 });
    assert.equal(takeRunnerWarmLossNotice(DEVICE.id)?.reason, 'runner_destination_lost');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a close after the retention window ended acts on nothing', async () => {
  const listener = await listen();
  const observe = stubHost({ boots: [{ observed: true, bootedAtMs: Date.now() + 60_000 }] });
  let armed = true;
  const { params, onStop } = watchParams(listener.port, { isArmed: () => armed });

  attachRunnerDestinationWatch(params);
  const socket = await listener.nextConnection();
  armed = false;
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(observe.mock.calls.length, 0);
  assert.equal(onStop.mock.calls.length, 0);
  assert.equal(takeRunnerWarmLossNotice(DEVICE.id), undefined);
});

test('closing the watch detaches it so a later runner death stops nothing', async () => {
  const listener = await listen();
  const observe = stubHost({ boots: [{ observed: true, bootedAtMs: Date.now() + 60_000 }] });
  const { params, onStop } = watchParams(listener.port);

  attachRunnerDestinationWatch(params);
  const socket = await listener.nextConnection();
  closeRunnerDestinationWatch(DEVICE.id);
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(observe.mock.calls.length, 0);
  assert.equal(onStop.mock.calls.length, 0);
});

test('a second retention window re-arms the existing watch instead of stacking another', async () => {
  const listener = await listen();
  stubHost({ boots: [{ observed: true, bootedAtMs: Date.now() + 60_000 }] });
  const first = watchParams(listener.port);
  const second = watchParams(listener.port);

  attachRunnerDestinationWatch(first.params);
  const socket = await listener.nextConnection();
  attachRunnerDestinationWatch(second.params);
  socket.destroy();
  await vi.waitFor(() => assert.equal(second.onStop.mock.calls.length, 1));

  assert.equal(first.onStop.mock.calls.length, 0);
  assert.equal(listener.connections.length, 0);
});
