import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { closeLoopbackServer, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { postRpcCommand, startRpcServer } from './http-server-rpc.fixtures.ts';

const TOKEN = 'throwing-handler-token';

// What happens when an admitted call's own handler rejects: the invocation's catch answers it with
// that call's id, its JSON-RPC -32000, and the typed reason intact, and the request lifecycle stays
// usable for the call that follows. It is also the closest reachable stand-in for the invariant the
// detached `.catch` in the server defends — a `/rpc` request never leaves a rejection for the
// process to find, because the daemon exits on `unhandledRejection` — though the answer here comes
// from the invocation, exactly as it did before that `.catch` existed.
test('a rejecting handler is answered for its own call id and never reaches the process', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const rejections: string[] = [];
  const observeRejection = (reason: unknown) => {
    rejections.push(String(reason));
  };
  process.on('unhandledRejection', observeRejection);
  let dispatched = 0;
  const { port, server } = await startRpcServer(TOKEN, async () => {
    dispatched += 1;
    throw new AppError('COMMAND_FAILED', 'the handler could not finish', {
      reason: 'handler_probe',
    });
  });
  try {
    const first = await postRpcCommand(port, TOKEN, 'req-handler-throws');
    assert.equal(first.status, 500);
    assert.equal(first.body.id, 'req-handler-throws', 'the answer carries the call it answers');
    assert.equal(first.body.error?.code, -32000);
    assert.deepEqual(
      first.body.error?.data?.details?.reason,
      'handler_probe',
      'the typed reason survives to the client',
    );
    assert.equal(dispatched, 1);

    // And the daemon is still a daemon: a later call on the same server runs and answers.
    const second = await postRpcCommand(port, TOKEN, 'req-after-handler-throws');
    assert.equal(second.body.error?.code, -32000, 'the second call reaches the same handler');
    assert.equal(dispatched, 2, 'the rejecting call left the request lifecycle usable');
    assert.deepEqual(rejections, [], 'a rejecting handler never reaches the process');
  } finally {
    process.off('unhandledRejection', observeRejection);
    await closeLoopbackServer(server);
  }
});
