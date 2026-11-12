import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'vitest';
import { SnapshotSourceError } from '@agent-device/capture-kit/snapshot-source-channel';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createSnapshotSourceHost } from './host.ts';
import { SnapshotBridgeManager } from './lifecycle.ts';
import {
  encodeSnapshotBridgeFrame,
  SNAPSHOT_SOURCE_PROTOCOL_VERSION,
  SNAPSHOT_SOURCE_VERSION,
} from './protocol.ts';
import { bridge, createLifecycleFixture, deadline, limits, target } from './lifecycle.fixtures.ts';

test('a connected local socket owns errors before any request', async () => {
  const server = net.createServer();
  const socketPath = path.join(mkdtempForTestSync('bridge-socket-'), 's');
  server.listen(socketPath);
  await once(server, 'listening');
  const host = createSnapshotSourceHost(createLiveTestHostEnvironment());
  const socket = await host.connect(socketPath, { timeoutMs: 1000 });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.destroy(new Error('reset after connect'));
  await closed;
  assert.equal(socket.destroyed, true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('local socket closure between requests and in flight permits later acquisition', async () => {
  const server = net.createServer();
  const socketPath = path.join(mkdtempForTestSync('bridge-socket-'), 's');
  const peers: net.Socket[] = [];
  let reply = true;
  let receivedRequests = 0;
  server.on('connection', (peer) => {
    peers.push(peer);
    let buffered = Buffer.alloc(0);
    peer.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4 || buffered.length < buffered.readUInt32BE(0) + 4) return;
      const size = buffered.readUInt32BE(0);
      const request = JSON.parse(buffered.subarray(4, size + 4).toString());
      receivedRequests += 1;
      buffered = buffered.subarray(size + 4);
      if (!reply) {
        peer.destroy();
        return;
      }
      peer.write(
        encodeSnapshotBridgeFrame(
          {
            protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
            sourceVersion: SNAPSHOT_SOURCE_VERSION,
            requestId: request.requestId,
            ok: true,
            pid: request.pid,
            generation: request.generation,
            truncated: false,
            automationEnabled: true,
            tree: { XC_kAXXCAttributeElementType: 'Application', XC_kAXXCAttributeChildren: [] },
          },
          limits,
        ),
      );
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const fixture = createLifecycleFixture();
  const realHost = createSnapshotSourceHost(createLiveTestHostEnvironment());
  const manager = new SnapshotBridgeManager({
    ...fixture.host,
    connect: (_path, options) => realHost.connect(socketPath, options),
  });
  const request = () =>
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline(undefined, 5000) });
  try {
    await request();
    const closed = once(peers[0]!, 'close');
    peers[0]!.destroy();
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await request();
    assert.equal(peers.length, 2);
    reply = false;
    await assert.rejects(
      request(),
      (error: unknown) =>
        error instanceof SnapshotSourceError &&
        error.failureKind === 'transport-failure' &&
        error.failureCode === 'bridge-connection-closed',
    );
    assert.equal(receivedRequests, 3);
    reply = true;
    await request();
    assert.equal(peers.length, 3);
    assert.equal(receivedRequests, 4);
  } finally {
    await manager.close();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a late error from an older socket does not invalidate its replacement', async () => {
  const fixture = createLifecycleFixture();
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = () =>
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline(undefined, 5000) });
  try {
    await request();
    const old = fixture.sockets[0]!;
    old.destroy = () => {
      old.destroyed = true;
    };
    old.emit('error', new Error('first reset'));
    await request();
    old.emit('error', new Error('late reset'));
    await request();
    assert.equal(fixture.sockets.length, 2);
    assert.equal(fixture.sockets[1]!.writes, 2);
    old.emit('close');
  } finally {
    await manager.close();
  }
});
