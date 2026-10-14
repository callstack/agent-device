import { test } from 'vitest';
import assert from 'node:assert/strict';
import { closeLoopbackServer, skipWhenLoopbackUnavailable } from '@agent-device/test-kit/loopback';
import { postRpcCommand, postRpcRaw, startRpcServer } from './http-server-rpc.fixtures.ts';
import type { DaemonResponse } from '../../core/daemon-request.ts';

const TOKEN = 'invalid-body-token';

// What separates these from the sibling suites: `http-server-rpc-validation.test.ts` covers bodies
// that ARE one object with unsound params, and `http-server-rpc-admission.test.ts` the order of the
// gates a sound call passes. This covers the step in front of all of them: a body whose JSON root
// is not one object at all. Such a body is not a call — it has no `id` to answer for and no method
// to route — so it is refused before the token is compared. Refusing it is the whole difference
// between a bad client and a daemon that dies: on `main` the `null` root threw while the flow read
// `jsonrpc` off it, and that rejection reached the daemon's `unhandledRejection` handler, which
// exits the process. Any process that could reach the port could stop the daemon without a token,
// and a test server with no such process handler shows only a hung connection.

test('a /rpc body whose root is not one object is refused as -32600 without a token', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let handlerCalls = 0;
  const { port, server } = await startRpcServer(TOKEN, async () => {
    handlerCalls += 1;
    return { ok: true, data: {} };
  });
  try {
    // `42`, `"x"` and `true` were already refused by reading `jsonrpc` off a value whose property
    // is simply undefined; `null` is the root that read throws on, and `[]` the one that reads as
    // an object, so every root shape is pinned rather than the one that happened to break.
    for (const [root, label] of [
      ['null', 'null root'],
      ['42', 'number root'],
      ['"x"', 'string root'],
      ['[]', 'array root'],
      ['true', 'boolean root'],
    ] as const) {
      // A BAD token on purpose: the refusal belongs ahead of the token gate, which is exactly why
      // an unauthenticated caller must not be able to make the daemon act on its body.
      const { status, body } = await postRpcRaw(port, 'wrong-token', root);
      assert.equal(status, 400, `${label}: refused with 400`);
      assert.equal(body.error?.code, -32600, `${label}: refused as Invalid Request`);
      assert.equal(
        (body as { id?: unknown }).id,
        null,
        `${label}: a body that is not a call has no id to answer for`,
      );
    }
    assert.equal(handlerCalls, 0, 'a body that is not a call must never reach the handler');
  } finally {
    await closeLoopbackServer(server);
  }
});

// The refusal is only half of the guarantee; the other half is that the daemon is still there
// afterwards with no rejection escaping to the process. Every body here is posted with a
// client-side deadline, so a regression that answers nothing reports the missing answer rather
// than a suite timeout. The bodies that never parse share the socket's -32700 path and must not
// cost the daemon either.
test('the daemon keeps serving after the bodies that never became a call', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const rejections: string[] = [];
  const observeRejection = (reason: unknown) => {
    rejections.push(String(reason));
  };
  process.on('unhandledRejection', observeRejection);
  const { port, server } = await startRpcServer(TOKEN, async (): Promise<DaemonResponse> => ({
    ok: true,
    data: {},
  }));
  try {
    assert.equal((await postRpcRaw(port, TOKEN, 'null')).status, 400, 'the null root is answered');
    for (const root of ['{oops', '']) {
      assert.equal(
        (await postRpcRaw(port, TOKEN, root)).status,
        400,
        `${root}: a body that never parsed is answered`,
      );
    }
    assert.equal(
      (await postRpcCommand(port, TOKEN, 'req-after-invalid-body')).status,
      200,
      'a valid call after the refusals still runs',
    );
    assert.deepEqual(rejections, [], 'no /rpc body may escape the flow as an unhandled rejection');
  } finally {
    process.off('unhandledRejection', observeRejection);
    await closeLoopbackServer(server);
  }
});
