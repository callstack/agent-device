import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createDaemonHttpServer } from '../server/http-server.ts';
import { resolveSessionRequestLogPath } from '../session-store.ts';
import { safeSessionName } from '../session-paths.ts';
import type { DaemonResponse } from '../types.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/index.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const RECORD = '{"phase":"request_start"}\n{"phase":"request_failed"}\n';

function writeRecord(sessionsDir: string, session: string, requestId: string): string {
  const recordPath = resolveSessionRequestLogPath(
    path.join(sessionsDir, safeSessionName(session)),
    requestId,
  );
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, RECORD);
  return recordPath;
}

async function withDiagnosticsServer(
  run: (context: { baseUrl: string; sessionsDir: string }) => Promise<void>,
): Promise<void> {
  const stateDir = mkdtempForTestSync('agent-device-request-diagnostics-');
  const sessionsDir = path.join(stateDir, 'sessions');
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    resolveRequestDiagnosticsPath: (ref) =>
      resolveSessionRequestLogPath(
        path.join(sessionsDir, safeSessionName(ref.session)),
        ref.requestId,
      ),
  });
  try {
    const port = await listenOnLoopback(server);
    await run({ baseUrl: `http://127.0.0.1:${port}`, sessionsDir });
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

async function requestRawStatus(baseUrl: string, requestTarget: string): Promise<number> {
  const url = new URL(baseUrl);
  return await new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: 'GET',
        path: requestTarget,
        headers: { authorization: 'Bearer daemon-secret' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function diagnosticsUrl(baseUrl: string, session: string, requestId: string): string {
  return `${baseUrl}/sessions/${encodeURIComponent(session)}/requests/${encodeURIComponent(requestId)}/diagnostics`;
}

test('request diagnostics route serves one record as ndjson to an authorized caller', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'cwd:9f1:default', 'abc123');
    const response = await fetch(diagnosticsUrl(baseUrl, 'cwd:9f1:default', 'abc123'), {
      headers: { authorization: 'Bearer daemon-secret' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(RECORD)));
    assert.equal(await response.text(), RECORD);
  });
});

test('request diagnostics route refuses an unauthenticated caller', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'default', 'abc123');
    const response = await fetch(diagnosticsUrl(baseUrl, 'default', 'abc123'));
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes('request_start'), false);
  });
});

test('request diagnostics route answers 404 for a record that was never written', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'default', 'abc123');
    const auth = { authorization: 'Bearer daemon-secret' };
    const unknownRequest = await fetch(diagnosticsUrl(baseUrl, 'default', 'nope'), {
      headers: auth,
    });
    assert.equal(unknownRequest.status, 404);
    const unknownSession = await fetch(diagnosticsUrl(baseUrl, 'other', 'abc123'), {
      headers: auth,
    });
    assert.equal(unknownSession.status, 404);
  });
});

test('request diagnostics route rejects ids that do not name one record', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'default', 'abc123');
    // Sent over a raw request rather than `fetch`: URL parsing resolves `..`
    // away client-side, so only a hand-built request target reaches the daemon
    // with the segment a traversal attempt would actually carry.
    for (const [session, requestId] of [
      ['..', 'abc123'],
      ['default', '..'],
      ['', 'abc123'],
      ['default', ''],
    ] as const) {
      const status = await requestRawStatus(
        baseUrl,
        `/sessions/${session}/requests/${requestId}/diagnostics`,
      );
      assert.equal(status, 400, `expected 400 for session=${session} request=${requestId}`);
    }
  });
});

test('request diagnostics route keeps a tenant inside its own session namespace', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'tenant-a:default', 'abc123');
    const auth = { authorization: 'Bearer daemon-secret' };
    const owner = await fetch(diagnosticsUrl(baseUrl, 'tenant-a:default', 'abc123'), {
      headers: { ...auth, 'x-agent-device-tenant': 'tenant-a' },
    });
    assert.equal(owner.status, 200);
    const otherTenant = await fetch(diagnosticsUrl(baseUrl, 'tenant-a:default', 'abc123'), {
      headers: { ...auth, 'x-agent-device-tenant': 'tenant-b' },
    });
    assert.equal(otherTenant.status, 401);
    assert.equal((await otherTenant.text()).includes('request_start'), false);
  });
});
