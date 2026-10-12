import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { DaemonResponse } from '../daemon-request.ts';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { closeLoopbackServer, skipWhenLoopbackUnavailable } from '@agent-device/test-kit/loopback';
import { postRpcCommand, startRpcServer } from './http-server-rpc.fixtures.ts';

const TOKEN = 'lifetime-token';

// Both cases end with the tracking id free, and the admitted case shows the handler running
// against a live signal. A call that registered and never released would keep its id claimed, so
// the rerun below would be refused as `duplicate_request_id`. The token gate refuses a call that
// already registered — admission order is pinned in `http-server-rpc-admission.test.ts` — so
// this is where that release is pinned. Disconnect and streaming releases live in
// `daemon-http-server.test.ts` and `daemon-http-boundary-cancellation.test.ts`.
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
