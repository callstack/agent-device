import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import { createNetworkConditioner } from './proxy-conditioner.ts';

test('forwards an RPC response and records exact body bytes at zero loss', async () => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end('{"result":{"ok":true}}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const conditioner = await createNetworkConditioner({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    network: { rttMs: 0, bandwidthKbps: null, packetLossPercent: 0, seed: 1 },
  });
  try {
    const response = await fetch(`${conditioner.baseUrl}/agent-device/rpc`, {
      method: 'POST',
      body: '{"request":true}',
    });
    assert.equal(await response.text(), '{"result":{"ok":true}}');
    assert.deepEqual(conditioner.recordsSince(0), [
      {
        sequence: 1,
        requestBytes: 16,
        responseBytes: 22,
        status: 200,
        failed: false,
      },
    ]);
  } finally {
    await conditioner.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('rejects non-loopback upstreams before binding the conditioner', async () => {
  await assert.rejects(
    createNetworkConditioner({
      upstreamBaseUrl: 'https://example.com:443',
      network: { rttMs: 0, bandwidthKbps: null, packetLossPercent: 0, seed: 1 },
    }),
    /must be an HTTP 127\.0\.0\.1 URL with a port/,
  );
});

test('does not forward unsupported paths upstream', async () => {
  const upstream = http.createServer((_request, response) => response.end('unexpected'));
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const conditioner = await createNetworkConditioner({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    network: { rttMs: 0, bandwidthKbps: null, packetLossPercent: 0, seed: 1 },
  });
  try {
    const response = await fetch(`${conditioner.baseUrl}/unsupported`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
  } finally {
    await conditioner.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
