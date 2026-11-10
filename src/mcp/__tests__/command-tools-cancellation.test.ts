import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import * as daemonClient from '@agent-device/daemon-client';
import { createCommandToolExecutor } from '../command-tools.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// MCP `notifications/cancelled` and the AI SDK's `abortSignal` both arrive as the executor's
// `signal`. The executor builds one client per call, so the signal must reach the daemon
// transport that client sends through; that transport is what closes the in-flight request.
test('a tool call signal reaches the daemon transport and an abort settles the call', async () => {
  const seen: Array<AbortSignal | undefined> = [];
  vi.spyOn(daemonClient, 'createEnsuredDaemonTransport').mockReturnValue(
    async (_req, context) =>
      await new Promise((_resolve, reject) => {
        seen.push(context?.signal);
        context?.signal?.addEventListener('abort', () => reject(context.signal?.reason));
      }),
  );
  const controller = new AbortController();
  const executor = createCommandToolExecutor();

  const pending = executor.execute('devices', {}, { signal: controller.signal });
  await vi.waitFor(() => assert.equal(seen.length, 1));
  assert.equal(seen[0], controller.signal);
  controller.abort(new Error('cancelled by client'));
  const result = await pending;

  assert.equal(result.isError, true);
});
