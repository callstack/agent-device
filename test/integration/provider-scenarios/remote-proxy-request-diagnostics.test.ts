/**
 * A client behind `agent-device proxy` must get the SAME failure envelope a
 * client on the daemon host gets (#1801), including for the plain sessions
 * `scopeRequestSession` leaves unscoped.
 *
 * The proxy forwards `x-agent-device-tenant` verbatim, so a caller that carries
 * a tenant identity reaches the diagnostics route with that identity even
 * though its command ran in a plain session such as `cwd:<hash>:default`. The
 * record read must not be stricter than the write that produced it: on a daemon
 * with no auth hook that same caller can already run any command in any session
 * over `/rpc`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import { createDaemonProxyServer } from '@agent-device/proxy';
import { localizeRemoteDaemonError } from '@agent-device/remote/remote-request-diagnostics';
import type { DaemonError } from '@agent-device/kernel/errors';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

const UPSTREAM_TOKEN = 'upstream-token';
const PROXY_TOKEN = 'proxy-token';
const TENANT = 'local-proxy-tenant';
/** What `resolveEffectiveSessionName` names an implicit session outside tenant isolation. */
const PLAIN_SESSION = 'cwd:9f1:default';
const REQUEST_ID = 'abc123';
const RECORD = '{"phase":"request_start"}\n{"phase":"request_failed"}\n';

function remoteError(): DaemonError {
  return {
    code: 'COMMAND_FAILED',
    message: 'wait timed out',
    logPath: '/Users/daemon-host/.agent-device/sessions/cwd_9f1_default/requests/abc123.ndjson',
    diagnosticsRecord: { session: PLAIN_SESSION, requestId: REQUEST_ID },
  };
}

test('Provider-backed integration local proxy serves a plain-session diagnostics record', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'local proxy request diagnostics coverage')) return;

  const stateDir = mkdtempForTestSync('agent-device-proxy-request-diagnostics-');
  const upstream = http.createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.match(request.url ?? '', /\/sessions\/.*\/requests\/abc123\/diagnostics$/);
    assert.equal(request.headers.authorization, `Bearer ${UPSTREAM_TOKEN}`);
    assert.equal(request.headers['x-agent-device-tenant'], TENANT);
    response.statusCode = 200;
    response.end(RECORD);
  });
  const upstreamBaseUrl = `http://127.0.0.1:${await listenOnLoopback(upstream)}`;
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl,
    upstreamToken: UPSTREAM_TOKEN,
    clientToken: PROXY_TOKEN,
  });

  try {
    const proxyBaseUrl = `http://127.0.0.1:${await listenOnLoopback(proxy)}/agent-device`;

    const throughProxy = await localizeRemoteDaemonError(remoteError(), {
      endpoint: { baseUrl: proxyBaseUrl, token: PROXY_TOKEN, tenantId: TENANT },
      stateDir: path.join(stateDir, 'proxy-client'),
    });
    assert.equal(throughProxy.logPathUnavailable, undefined, 'the proxy must serve the record');
    assert.notEqual(throughProxy.logPath, undefined);
    assert.equal(fs.readFileSync(throughProxy.logPath!, 'utf8'), RECORD);

    // Parity: the client on the daemon host localizes byte-identical content.
    const direct = await localizeRemoteDaemonError(remoteError(), {
      endpoint: { baseUrl: upstreamBaseUrl, token: UPSTREAM_TOKEN, tenantId: TENANT },
      stateDir: path.join(stateDir, 'direct-client'),
    });
    assert.equal(direct.logPathUnavailable, undefined);
    assert.equal(fs.readFileSync(direct.logPath!, 'utf8'), RECORD);
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
