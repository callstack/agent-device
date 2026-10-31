import assert from 'node:assert/strict';
import { test } from 'vitest';
import { closeLoopbackServer, supportsLoopbackBind } from '@agent-device/test-kit';
import { okResult, startScriptedDaemon } from './explicit-lifecycle-fixture.ts';

// The stand-in daemon is a loopback server on an ephemeral port, so anything else on the host that
// probes listening ports can reach it. Only the client under test speaks `POST /rpc`.

test('a stray request that is not a daemon request is refused and never recorded', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const daemon = await startScriptedDaemon(okResult({}));
  const base = `http://127.0.0.1:${daemon.port}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/rpc`)).status, 404);
    assert.equal((await fetch(`${base}/other`, { method: 'POST', body: '' })).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.deepEqual(daemon.rpcRequests, []);

    const answered = await fetch(`${base}/rpc`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 'r1', params: { command: 'devices' } }),
    });
    assert.equal(answered.status, 200);
    assert.deepEqual(daemon.rpcCommands, ['devices']);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});
