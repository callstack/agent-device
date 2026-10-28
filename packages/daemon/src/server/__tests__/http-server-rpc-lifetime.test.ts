import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { closeLoopbackServer, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { postRpcCommand, postRpcRaw, startRpcServer } from './http-server-rpc.fixtures.ts';
import { applicationLifecycleExecutionFromRequest } from '../../sessions/application-lifecycle-execution.ts';

const TOKEN = 'lifetime-token';

// Both cases end with the tracking id free, and the admitted case shows the handler running
// against a live signal. A call that registered and never released would keep its id claimed, so
// the rerun below would be refused as `duplicate_request_id`. The token gate refuses a call that
// already registered — admission order is pinned in `http-server-rpc-admission.test.ts` — so
// this is where that release is pinned. Disconnect and streaming releases live in
// `daemon-http-server.test.ts` and `http-server-boundary-cancellation.test.ts`.
test('an rpc request registers its tracking id while in flight and releases it once answered', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { port, server } = await startRpcServer(TOKEN, async (request) => {
    assert.ok(getRequestSignal(request.meta?.requestId), 'the handler must see its own signal');
    return { ok: true, data: {} } satisfies DaemonResponse;
  });
  try {
    for (const [scenario, bearerToken, expectedStatus] of [
      ['answered', TOKEN, 200],
      ['refused', 'wrong-token', 401],
    ] as const) {
      const requestId = `req-lifetime-${scenario}`;
      assert.equal((await postRpcCommand(port, bearerToken, requestId)).status, expectedStatus);
      assert.equal(getRequestSignal(requestId), undefined, `${scenario}: id must be released`);
      assert.equal((await postRpcCommand(port, TOKEN, requestId)).status, 200);
    }
  } finally {
    await closeLoopbackServer(server);
  }
});

test('an admitted open records a result deadline of its client envelope less the daemon result margin', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let deadlineAtMs: number | undefined;
  const { port, server } = await startRpcServer(TOKEN, async (request) => {
    deadlineAtMs = applicationLifecycleExecutionFromRequest(
      request,
      '/tmp/request.log',
    ).requestDeadlineAtMs;
    return { ok: true, data: {} } satisfies DaemonResponse;
  });
  try {
    const sentAtMs = Date.now();
    const requestId = 'req-open-result-deadline';
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'agent_device.command',
      params: { command: 'open', positionals: ['com.example.app'], meta: { requestId } },
    });
    assert.equal((await postRpcRaw(port, TOKEN, body)).status, 200);
    const answeredAtMs = Date.now();
    assert.ok(deadlineAtMs !== undefined, 'the open must carry a deadline');
    assert.ok(deadlineAtMs >= sentAtMs + 60_000 && deadlineAtMs <= answeredAtMs + 60_000);
  } finally {
    await closeLoopbackServer(server);
  }
});
