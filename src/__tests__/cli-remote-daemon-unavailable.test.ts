// A remote daemon that answers nothing stops the CLI before its request is sent. This runs the real
// CLI against a base URL with no listener, so what it reads is the `--json` failure envelope a
// caller branches on: the typed reason, and the fact that nothing was dispatched.

import http from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runCliCapture } from './cli-capture.ts';

/** An ephemeral loopback port with no listener: bind 127.0.0.1:0, read the port, close it. */
async function reserveUnusedLoopbackPort(): Promise<number> {
  const server = http.createServer();
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP port on the loopback listener');
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('--json carries the remote daemon refusal reason and its non-dispatch', async () => {
  const port = await reserveUnusedLoopbackPort();
  const result = await runCliCapture(['devices', '--json'], {
    useRealDaemonClient: true,
    env: { AGENT_DEVICE_DAEMON_BASE_URL: `http://127.0.0.1:${port}` },
  });

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout) as {
    success: boolean;
    error: { code: string; message: string; details?: Record<string, unknown> };
  };
  assert.equal(payload.success, false);
  assert.equal(payload.error.code, 'COMMAND_FAILED');
  assert.equal(payload.error.message, 'Remote daemon is unavailable');
  // The published wire values a --json consumer branches on, asserted as the strings themselves.
  assert.equal(payload.error.details?.reason, 'remote_daemon_unavailable');
  assert.equal(payload.error.details?.dispatched, 'no');
});
