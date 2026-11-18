import type { DaemonResponse } from '@agent-device/kernel/contracts';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDaemonHttpServer } from './http-server.ts';

test('the daemon HTTP server carries explicit 30-second header and 600-second body ingress ceilings', async () => {
  const server = await createDaemonHttpServer({
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    env: process.env,
    cwd: process.cwd(),
  });
  try {
    // Constructed settings, not a live wall-clock disconnect (#4441).
    assert.equal(server.headersTimeout, 30_000);
    assert.equal(server.requestTimeout, 600_000);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
