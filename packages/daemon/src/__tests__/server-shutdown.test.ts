import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { DaemonServer } from '../server/transport.ts';
import { closeDaemonServers } from '../server/server-shutdown.ts';

test('closeDaemonServers forces stuck servers after timeout', async () => {
  let destroyed = false;
  const server = {
    close: () => {},
    destroyConnections: () => {
      destroyed = true;
    },
  } as unknown as DaemonServer;

  const startedAt = Date.now();
  await closeDaemonServers([server], 20);

  assert.equal(destroyed, true);
  assert.ok(Date.now() - startedAt < 500);
});
