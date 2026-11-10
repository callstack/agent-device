import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import * as daemonClient from '@agent-device/daemon-client';
import { createMcpStdioSession } from '../server.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// The whole production route of a cancellation: stdio session, payload boundary, router, tool
// executor, and the daemon transport the call's client sends through. Only the transport is a
// stand-in, so a hop that drops the call's signal leaves the request running and fails this test.
test('notifications/cancelled aborts the daemon request of a running tools/call and writes nothing', async () => {
  const signals: Array<AbortSignal | undefined> = [];
  let settled = false;
  vi.spyOn(daemonClient, 'createEnsuredDaemonTransport').mockReturnValue(
    async (_req, context) =>
      await new Promise((_resolve, reject) => {
        signals.push(context?.signal);
        context?.signal?.addEventListener('abort', () => {
          settled = true;
          reject(context.signal?.reason);
        });
      }),
  );
  const writes: unknown[] = [];
  const session = createMcpStdioSession({ write: (message) => writes.push(message) });

  session.receive(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'devices', arguments: {} },
    })}\n`,
  );
  await vi.waitFor(() => assert.equal(signals.length, 1));
  session.receive(
    `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 41 },
    })}\n`,
  );
  await session.end();

  assert.equal(signals[0]?.aborted, true);
  assert.equal(settled, true);
  assert.deepEqual(writes, []);
});
