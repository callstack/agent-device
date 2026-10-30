import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { DeviceLease } from '@agent-device/contracts/device';
import { bindProviderSnapshotInteractor } from '@agent-device/contracts/snapshot-runtime';
import { AppError } from '@agent-device/kernel/errors';
import { afterEach, test, vi } from 'vitest';

import { createTvRuntime } from './runtime.ts';
import type { SnapshotCapture } from './snapshot.ts';
import type { TvConnection } from './tv.ts';

const APP_ID = 'com.example.app';

const CAPTURE: SnapshotCapture = {
  title: 'Example',
  truncated: false,
  // The DOM walk gives every node it keeps a rect.
  nodes: [
    { index: 0, depth: 0, type: 'main', label: 'Home' },
    { index: 1, depth: 1, parentIndex: 0, type: 'section', label: 'Settings' },
    { index: 2, depth: 2, parentIndex: 1, type: 'button', label: 'Sound', hittable: true },
    { index: 3, depth: 1, parentIndex: 0, type: 'section', label: 'Library' },
    { index: 4, depth: 2, parentIndex: 3, type: 'button', label: 'Movies', hittable: true },
    { index: 5, depth: 2, parentIndex: 3, type: 'p', label: 'New this week' },
  ].map((node) => ({ ...node, rect: { x: 0, y: 0, width: 200, height: 40 } })),
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function lease(leaseId: string): DeviceLease {
  return {
    leaseId,
    tenantId: 'tenant',
    runId: 'run',
    backend: 'android-instance',
    leaseProvider: 'webos',
    createdAt: 0,
    heartbeatAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const length =
    payload.length < 126
      ? Buffer.from([payload.length])
      : payload.length < 65_536
        ? Buffer.from([126, payload.length >> 8, payload.length & 0xff])
        : Buffer.concat([Buffer.from([127]), bigEndian64(payload.length)]);
  return Buffer.concat([Buffer.from([0x81]), length, payload]);
}

function bigEndian64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function readMaskedFrame(buffer: Buffer): { text: string; opcode: number; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!;
  return {
    text: payload.toString('utf8'),
    opcode: buffer[0]! & 0x0f,
    rest: buffer.subarray(offset + 4 + length),
  };
}

// Lists the app page while it runs, and answers every CDP call with an empty result, the
// readiness check with true, and the snapshot walk with CAPTURE.
async function fakePage() {
  const sockets = new Set<Duplex>();
  let running = true;
  const server = createServer((_request, response) => {
    const target = { title: APP_ID, url: `http://tv/${APP_ID}/`, webSocketDebuggerUrl: page.url };
    response.end(JSON.stringify(running ? [target] : []));
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let read = readMaskedFrame(pending); read; read = readMaskedFrame(pending)) {
        pending = read.rest;
        if (read.opcode === 0x8) return void socket.end();
        const { id, method, params } = JSON.parse(read.text);
        const expression = String(params?.expression ?? '');
        const result =
          method !== 'Runtime.evaluate'
            ? {}
            : { result: { value: expression.includes('readyState') ? true : CAPTURE } };
        socket.write(frame(JSON.stringify({ id, result })));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const page = {
    url: `ws://127.0.0.1:${address.port}/devtools/page/1`,
    drop: () => {
      for (const socket of sockets) socket.destroy();
    },
    exitApp: () => {
      running = false;
    },
    close: async () => {
      page.drop();
      server.close();
      await once(server, 'close');
    },
  };
  cleanups.push(page.close);
  return page;
}

async function tvRuntime(onLaunch: () => Promise<unknown> = async () => undefined) {
  const page = await fakePage();
  const tunnel = { closed: 0, onClose: [] as (() => void)[] };
  const tv: TvConnection = {
    name: 'living-room',
    launch: async (appId) => {
      await onLaunch();
      return {
        target: { title: appId, url: `http://tv/${appId}/`, webSocketDebuggerUrl: page.url },
        onClose: (listener) => tunnel.onClose.push(listener),
        close: () => void tunnel.closed++,
      };
    },
    close: async () => undefined,
    listApps: async () => [],
  };
  const { runtime } = createTvRuntime(
    {
      provider: 'webos',
      label: 'webOS',
      remoteKeys: {},
      connectTv: async () => tv,
    },
    { createError: (code, message, details) => new AppError(code, message, details) },
  );
  cleanups.push(runtime.shutdown);
  const allocated = await runtime.leaseLifecycle.allocate(lease('lease-a'));
  assert.ok(allocated);
  return { runtime, device: allocated.device, page, tunnel };
}

async function openedTv() {
  const opened = await tvRuntime();
  await opened.runtime.getInteractor(opened.device)!.open(APP_ID);
  return opened;
}

const noAttachedApp = (error: unknown) =>
  error instanceof AppError && /No webOS app is attached/.test(error.message);

test('a second lease on a held TV is refused with DEVICE_IN_USE', async () => {
  const { runtime } = await tvRuntime();

  await assert.rejects(
    runtime.leaseLifecycle.allocate(lease('lease-b')),
    (error: unknown) => error instanceof AppError && error.code === 'DEVICE_IN_USE',
  );
});

test('releasing the lease closes the tunnel and forgets the TV session', async () => {
  const { runtime, device, tunnel } = await openedTv();

  await runtime.leaseLifecycle.release(lease('lease-a'));

  assert.equal(tunnel.closed, 1);
  assert.equal(runtime.getInteractor(device), undefined);
  assert.ok(await runtime.leaseLifecycle.allocate(lease('lease-b')));
});

test('a page whose socket closes is detached, so commands ask for open again', async () => {
  const { runtime, device, page, tunnel } = await openedTv();

  page.drop();
  await vi.waitFor(() => assert.equal(tunnel.closed, 1));

  await assert.rejects(runtime.getInteractor(device)!.snapshot(), noAttachedApp);
});

test('an app that exits behind an open tunnel is detached once its target is gone', async () => {
  const { runtime, device, page, tunnel } = await openedTv();

  page.exitApp();
  await vi.waitFor(() => assert.equal(tunnel.closed, 1), { timeout: 5000 });

  await assert.rejects(runtime.getInteractor(device)!.snapshot(), noAttachedApp);
});

test('a tunnel that goes down detaches the page', async () => {
  const { runtime, device, tunnel } = await openedTv();

  for (const listener of tunnel.onClose) listener();

  await assert.rejects(runtime.getInteractor(device)!.snapshot(), noAttachedApp);
});

test('a lease released while open is in flight leaves no tunnel behind', async () => {
  let releaseLease = async (): Promise<unknown> => undefined;
  const { runtime, device, tunnel } = await tvRuntime(() => releaseLease());
  releaseLease = () => runtime.leaseLifecycle.release(lease('lease-a'));

  await assert.rejects(runtime.getInteractor(device)!.open(APP_ID), /lease ended/);

  assert.equal(tunnel.closed, 1);
});

async function capturedLabels(options: Readonly<{ scope?: string; interactiveOnly?: boolean }>) {
  const { runtime, device } = await openedTv();
  const operations = bindProviderSnapshotInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => runtime.getInteractor(device),
  });
  const result = await operations.captureSnapshot({ options });
  assert.ok('nodes' in result);
  return result.nodes?.map((node) => node.label);
}

test('a scoped capture through the provider snapshot binding returns only that subtree', async () => {
  assert.deepEqual(await capturedLabels({ scope: 'Settings' }), ['Settings', 'Sound']);
});

test('an interactive-only capture drops text-only nodes and keeps the ancestors of controls', async () => {
  assert.deepEqual(await capturedLabels({ interactiveOnly: true }), [
    'Home',
    'Settings',
    'Sound',
    'Library',
    'Movies',
  ]);
});
