import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, vi } from 'vitest';
import { localizeRemoteDaemonError } from '@agent-device/remote/remote-request-diagnostics';
import type { DaemonError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { createProviderScenarioHarness, createProviderScenarioProxy } from './harness.ts';

const PROXY_TOKEN = 'proxy-token';
/** An explicit plain session keeps colons in the diagnostics route segment. */
const PLAIN_SESSION = 'cwd:9f1:default';
const REQUEST_ID = 'abc123';

test('Provider-backed integration local proxy serves the daemon diagnostics record for the encoded plain session', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'local proxy request diagnostics coverage')) return;

  const daemon = await createProviderScenarioHarness({ deviceInventoryProvider: async () => [] });
  const proxy = await createProviderScenarioProxy(daemon, { clientToken: PROXY_TOKEN });
  const stateDir = mkdtempForTestSync('agent-device-proxy-request-diagnostics-');

  try {
    const failed = await proxy.callCommand(
      PROXY_TOKEN,
      'trace',
      ['stop'],
      {},
      {
        session: PLAIN_SESSION,
        meta: { requestId: REQUEST_ID, sessionExplicit: true },
      },
    );
    assert.equal(failed.statusCode, 200, JSON.stringify(failed.json));
    const error = failed.json.error?.data as DaemonError | undefined;
    assert.equal(error?.code, 'SESSION_NOT_FOUND', JSON.stringify(failed.json));
    assert.deepEqual(error?.diagnosticsRecord, {
      session: PLAIN_SESSION,
      requestId: REQUEST_ID,
    });

    const throughProxy = await localizeRemoteDaemonError(error!, {
      endpoint: { baseUrl: proxy.baseUrl, token: PROXY_TOKEN },
      stateDir: path.join(stateDir, 'proxy-client'),
    });
    assert.equal(throughProxy.logPathUnavailable, undefined, 'the proxy must serve the record');
    assert.notEqual(throughProxy.logPath, undefined);
    const proxyRecord = fs.readFileSync(throughProxy.logPath!, 'utf8');
    assert.match(proxyRecord, /"phase":"request_start"/);
    assert.match(proxyRecord, /"phase":"request_failed"/);

    const expectedPath = `/sessions/${encodeURIComponent(PLAIN_SESSION)}/requests/${REQUEST_ID}/diagnostics`;
    const forwardedRequests = proxy.forwarded.map((entry) => [
      entry.method,
      entry.route,
      entry.authorization,
      entry.tenantId,
      entry.statusCode,
    ]);
    assert.deepEqual(forwardedRequests, [
      ['POST', '/rpc', `Bearer ${daemon.token}`, undefined, 404],
      ['GET', expectedPath, `Bearer ${daemon.token}`, undefined, 200],
    ]);
    const forwardedRpc = proxy.forwarded[0];
    assert.ok(forwardedRpc);
    const forwardedRpcPayload = JSON.parse(forwardedRpc.requestBody) as {
      params?: { command?: string; session?: string };
    };
    assert.equal(forwardedRpcPayload.params?.command, 'trace');
    assert.equal(forwardedRpcPayload.params?.session, PLAIN_SESSION);
    const forwardedDiagnostics = proxy.forwarded.filter(
      (entry) => entry.method === 'GET' && entry.route.endsWith('/diagnostics'),
    );
    assert.deepEqual(
      forwardedDiagnostics.map((entry) => [
        entry.route,
        entry.authorization,
        entry.tenantId,
        entry.statusCode,
      ]),
      [[expectedPath, `Bearer ${daemon.token}`, undefined, 200]],
    );

    const directRequestSpy = vi.spyOn(http, 'request');
    try {
      const direct = await localizeRemoteDaemonError(error!, {
        endpoint: { baseUrl: daemon.baseUrl, token: daemon.token },
        stateDir: path.join(stateDir, 'direct-client'),
      });
      assert.equal(direct.logPathUnavailable, undefined);
      assert.equal(fs.readFileSync(direct.logPath!, 'utf8'), proxyRecord);

      const directRequest = directRequestSpy.mock.calls[0]?.[0];
      assert.ok(
        directRequest && typeof directRequest === 'object' && !(directRequest instanceof URL),
      );
      const directOptions = directRequest as {
        protocol?: string;
        host?: string;
        port?: string;
        method?: string;
        path?: string;
        headers?: Record<string, string>;
      };
      assert.equal(directRequestSpy.mock.calls.length, 1);
      assert.deepEqual(directOptions, {
        protocol: 'http:',
        host: '127.0.0.1',
        port: String(daemon.httpPort),
        method: 'GET',
        path: expectedPath,
        headers: {
          authorization: `Bearer ${daemon.token}`,
          'x-agent-device-token': daemon.token,
        },
      });
      assert.deepEqual(
        proxy.forwarded.map((entry) => [
          entry.method,
          entry.route,
          entry.authorization,
          entry.tenantId,
          entry.statusCode,
        ]),
        forwardedRequests,
        'direct diagnostics lookup must bypass the proxy',
      );
    } finally {
      directRequestSpy.mockRestore();
    }
  } finally {
    await proxy.close();
    await daemon.close();
  }
});
