import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import { closeLoopbackServer, skipWhenLoopbackUnavailable } from '@agent-device/test-kit/loopback';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { restoreEnv } from '@agent-device/test-kit/env';
import { postRpcCommand, startRpcServer } from './http-server-rpc.fixtures.ts';

const DAEMON_TOKEN = 'admission-daemon-secret';
const HOOK_CALLS_ENV = 'AGENT_DEVICE_TEST_HOOK_CALLS';
const ATTESTING_HOOK = `export default () => {
  process.env.${HOOK_CALLS_ENV} = String(Number(process.env.${HOOK_CALLS_ENV} ?? 0) + 1);
  return { tenantId: 'tenant-admitted' };
};
`;
const REJECTING_HOOK = "export default () => ({ ok: false, message: 'hook said no' });\n";

// What separates these from the sibling suites: `http-server-tenant-trust.test.ts` pins -32001
// for an unattested tenant, `http-instance-precondition.test.ts` pins a bad token ahead of the
// stale-instance 409. Neither says whether the operator's hook gets a turn before the token.
test('the rpc admission asks the auth hook before it compares the token', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const previousHook = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  try {
    for (const [index, hookSource] of [REJECTING_HOOK, ATTESTING_HOOK].entries()) {
      const requestId = `req-hook-order-${index}`;
      const dispatched: DaemonRequest[] = [];
      const { port, server } = await startWithAuthHook(hookSource, async (request) => {
        dispatched.push(request);
        return { ok: true, data: {} };
      });
      try {
        const response = await postRpcCommand(port, 'wrong-token', requestId);
        assert.equal(response.status, 401);
        // A rejecting hook answers first; once it attests, the bad token is the gate left.
        assert.equal(response.body.error?.code, index === 0 ? -32001 : -32000);
        assert.equal(dispatched.length, 0, 'a refused call must never reach the router');
      } finally {
        await closeLoopbackServer(server);
      }
    }
  } finally {
    restoreEnv('AGENT_DEVICE_HTTP_AUTH_HOOK', previousHook);
  }
});

// The tracking id is registered ahead of the gate, so the loser of a duplicate-id race is
// refused by the registration and the operator's hook never sees it. The hook runs in this
// process, so it can count its own invocations and say so.
test('the rpc admission registers the tracking id before consulting the auth hook', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const previousHook = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  const previousCalls = process.env[HOOK_CALLS_ENV];
  delete process.env[HOOK_CALLS_ENV];

  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release: () => void = () => {};
  const { port, server } = await startWithAuthHook(ATTESTING_HOOK, async () => {
    markStarted();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true, data: {} };
  });

  try {
    const first = postRpcCommand(port, DAEMON_TOKEN, 'req-admission');
    await started;
    assert.equal(hookCalls(), 1, 'the admitted call consulted the hook');

    const duplicate = await postRpcCommand(port, DAEMON_TOKEN, 'req-admission');
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.body.error?.data?.details?.reason, 'duplicate_request_id');
    assert.equal(
      hookCalls(),
      1,
      'the auth hook must not see a call the tracking-id registration already refused',
    );

    release();
    assert.equal((await first).status, 200);
  } finally {
    restoreEnv('AGENT_DEVICE_HTTP_AUTH_HOOK', previousHook);
    restoreEnv(HOOK_CALLS_ENV, previousCalls);
    release();
    await closeLoopbackServer(server);
  }
});

function hookCalls(): number {
  return Number(process.env[HOOK_CALLS_ENV] ?? 0);
}

async function startWithAuthHook(
  hookSource: string,
  handleRequest: (request: DaemonRequest) => Promise<DaemonResponse>,
) {
  const hookPath = path.join(mkdtempForTestSync('agent-device-rpc-admission-'), 'hook.mjs');
  fs.writeFileSync(hookPath, hookSource);
  process.env.AGENT_DEVICE_HTTP_AUTH_HOOK = hookPath;
  return startRpcServer(DAEMON_TOKEN, handleRequest);
}
