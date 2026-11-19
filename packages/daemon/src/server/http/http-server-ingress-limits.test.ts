import type { DaemonResponse } from '@agent-device/kernel/contracts';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDaemonHttpServer } from './http-server.ts';
import { UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS } from './ingress-budget.ts';

test('the daemon HTTP server carries a 30-second header ceiling and a request ceiling behind the upload aggregate', async () => {
  const server = await createDaemonHttpServer({
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    env: process.env,
    cwd: process.cwd(),
  });
  try {
    // Constructed settings, not a live wall-clock disconnect (#4441).
    assert.equal(server.headersTimeout, 30_000);
    // The upload owner answers an expired body with its typed reason before the socket
    // timeout can close the request.
    assert.ok(server.requestTimeout > UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS);
    // Node starts the request clock at message start and polls header expiry only at
    // its checking interval, so the ceiling also covers the worst admitted header time.
    assert.ok(
      server.requestTimeout >
        server.headersTimeout +
          (server as typeof server & { connectionsCheckingInterval: number })
            .connectionsCheckingInterval +
          UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS,
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
