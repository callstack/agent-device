import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDaemonHttpServer } from './http-server.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  restoreEnv,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

const DAEMON_TOKEN = 'daemon-secret';

function writeAuthHook(root: string, source: string): string {
  const hookPath = path.join(root, 'auth-hook.mjs');
  fs.writeFileSync(hookPath, source);
  return hookPath;
}

/**
 * Drives an auxiliary route (request diagnostics) through the shared
 * token/auth-hook gate with a hook whose source is `hookSource`. The record
 * never has to exist: a rejection answers before the record is resolved.
 */
async function withAuxRouteAndHook(
  hookSource: string,
  run: (ctx: { baseUrl: string }) => Promise<void>,
): Promise<void> {
  const root = mkdtempForTestSync('agent-device-http-auth-rejection-');
  const previousHook = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  process.env.AGENT_DEVICE_HTTP_AUTH_HOOK = writeAuthHook(root, hookSource);
  const server = await createDaemonHttpServer({
    token: DAEMON_TOKEN,
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    resolveRequestDiagnosticsPath: () => path.join(root, 'unused-request-log.json'),
  });
  try {
    const port = await listenOnLoopback(server);
    await run({ baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await closeLoopbackServer(server);
    restoreEnv('AGENT_DEVICE_HTTP_AUTH_HOOK', previousHook);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function fetchDiagnostics(baseUrl: string): Promise<Response> {
  return await fetch(`${baseUrl}/sessions/default/requests/abc123/diagnostics`, {
    headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
  });
}

// An auth hook's own rejection on an auxiliary route must reach the caller as the flat REST error
// shape those routes answer with (`{ ok: false, error }` at the hook's status code), not as a
// JSON-RPC envelope or a generic 401 that drops the hook's message.

test('aux route: a hook returning bare false answers 401 with the default rejection message', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  await withAuxRouteAndHook(
    'export default function authHook() { return false; }\n',
    async ({ baseUrl }) => {
      const response = await fetchDiagnostics(baseUrl);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('content-type'), 'application/json');
      const body = (await response.json()) as { ok?: boolean; error?: string };
      assert.equal(body.ok, false);
      assert.equal(body.error, 'Request rejected by auth hook');
    },
  );
});

test('aux route: a hook returning a structured rejection keeps its message and 401 status', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  await withAuxRouteAndHook(
    "export default function authHook() { return { ok: false, code: 'FORBIDDEN', message: 'denied by policy' }; }\n",
    async ({ baseUrl }) => {
      const response = await fetchDiagnostics(baseUrl);
      assert.equal(response.status, 401);
      const body = (await response.json()) as { ok?: boolean; error?: string };
      assert.equal(
        body.error,
        'denied by policy',
        "the hook's own message must survive the REST rendering",
      );
    },
  );
});

test('aux route: a hook returning an invalid tenantId answers 500, not a 401 caller-retry trap', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  await withAuxRouteAndHook(
    "export default function authHook() { return { tenantId: 'not a valid tenant!!' }; }\n",
    async ({ baseUrl }) => {
      const response = await fetchDiagnostics(baseUrl);
      // The hook itself is broken (its attestation failed validation); that is a server fault, so
      // the status must not masquerade as a client auth failure a retry could fix.
      assert.equal(response.status, 500);
      const body = (await response.json()) as { ok?: boolean; error?: string };
      assert.match(body.error ?? '', /invalid tenantId/i);
    },
  );
});
