import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { NormalizedError } from '@agent-device/kernel/errors';
import { closeLoopbackServer, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { postRpcCommand, startRpcServer } from './http-server-rpc.fixtures.ts';

const TOKEN = 'unowned-failure-token';

// `http-server-rpc-handler-failure.test.ts` pins a handler rejection the flow answers with the
// call's own id. This covers the step behind it: the flow rejects with a reason its own catches
// cannot read, so nothing upstream of the detached `.catch` has answered and no call id is safe to
// echo. The refusal carries `id: null`, the failure goes to the sink the server was given rather
// than to a stream this module does not own, and the daemon is still a daemon afterwards.
test('a flow rejection nothing upstream answered is refused without a call id and reported', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const rejections: unknown[] = [];
  // Records the reason without inspecting it: this one throws on every property read, including
  // the coercion an assertion would perform on it.
  const observeRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  const reported: NormalizedError[] = [];
  const { port, server } = await startRpcServer(
    TOKEN,
    async (request): Promise<DaemonResponse> => {
      if (request.meta?.requestId?.startsWith('req-unowned')) throw unwrappableReason();
      return { ok: true, data: {} };
    },
    {
      // Throws on its first event: the sink is the caller's code, and a sink that cannot take the
      // event must not cost the client the answer this branch exists to give.
      onUnownedRequestFailure: (failure) => {
        reported.push(failure);
        if (reported.length === 1) throw new Error('the sink is down');
      },
    },
  );
  try {
    // Registered only once the server exists: a setup throw must not leave the listener on the
    // process for the rest of the worker.
    process.on('unhandledRejection', observeRejection);
    const answer = await postRpcCommand(port, TOKEN, 'req-unowned-failure');
    assert.equal(answer.status, 500, 'an unanswered flow rejection is refused with 500');
    assert.equal(
      answer.body.id,
      null,
      'a reason that cannot be read leaves no call id safe to echo',
    );
    assert.equal(answer.body.error?.code, -32000, 'refused as an internal error');
    assert.equal(reported.length, 1, 'the sink heard about the failure');
    assert.deepEqual(
      reported.map((failure) => [failure.code, failure.message]),
      [['UNKNOWN', 'Unknown error']],
      'an unreadable reason is reported as the unknown-error failure, never as a half-read one',
    );

    // The sink throwing did not cost the caller its answer, and the next call runs normally: the
    // rejection left the request lifecycle as usable as it found it.
    const next = await postRpcCommand(port, TOKEN, 'req-after-unowned-failure');
    assert.equal(next.status, 200, 'the next call on the same server still runs and answers');
    assert.equal(rejections.length, 0, 'a flow rejection never reaches the process');
  } finally {
    process.off('unhandledRejection', observeRejection);
    await closeLoopbackServer(server);
  }
});

/**
 * A rejection reason that cannot be inspected: the one property `normalizeError` must read to
 * redact its diagnostics throws the reason itself, so both of the flow's own catches fail while
 * computing their answer. That is the only way to land in the detached `.catch` a reason nothing has
 * answered and nothing can name. It stays printable, so a run without the fix reports the escaped
 * rejection instead of failing to format it.
 */
function unwrappableReason(): Record<string, unknown> {
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, 'details', {
    enumerable: true,
    get(): never {
      throw hostile;
    },
  });
  return hostile;
}
