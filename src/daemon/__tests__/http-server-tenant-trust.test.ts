import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDaemonHttpServer } from '../server/http-server.ts';
import { resolveSessionRequestLogPath } from '../session-store.ts';
import { safeSessionName } from '../session-paths.ts';
import { DAEMON_HTTP_TENANT_HEADER } from '../http-contract.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { restoreEnv } from '../../__tests__/test-utils/env.ts';

const DAEMON_TOKEN = 'daemon-secret';
const DIAGNOSTICS_RECORD = '{"phase":"request_start"}\n{"phase":"request_failed"}\n';

function writeSilentAuthHook(root: string): string {
  const hookPath = path.join(root, 'silent-auth-hook.mjs');
  fs.writeFileSync(hookPath, 'export default function authHook() { return { ok: true }; }\n');
  return hookPath;
}

const ATTESTED_TENANT_ID = 'tenant-real';

function writeAttestingAuthHook(root: string): string {
  const hookPath = path.join(root, 'attesting-auth-hook.mjs');
  fs.writeFileSync(
    hookPath,
    "export default function authHook() { return { tenantId: 'tenant-real' }; }\n",
  );
  return hookPath;
}

async function withRpcServer(
  hookPath: string | undefined,
  run: (ctx: { baseUrl: string; observedRequests: DaemonRequest[] }) => Promise<void>,
): Promise<void> {
  const previousHook = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  if (hookPath) process.env.AGENT_DEVICE_HTTP_AUTH_HOOK = hookPath;
  else delete process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;

  const observedRequests: DaemonRequest[] = [];
  const server = await createDaemonHttpServer({
    token: DAEMON_TOKEN,
    handleRequest: async (req): Promise<DaemonResponse> => {
      observedRequests.push(req);
      return { ok: true, data: { meta: req.meta } };
    },
  });
  try {
    const port = await listenOnLoopback(server);
    await run({ baseUrl: `http://127.0.0.1:${port}`, observedRequests });
  } finally {
    await closeLoopbackServer(server);
    restoreEnv('AGENT_DEVICE_HTTP_AUTH_HOOK', previousHook);
  }
}

async function callRpc(
  baseUrl: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${DAEMON_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function withDiagnosticsHookServer(
  hookPath: string | undefined,
  run: (ctx: { baseUrl: string; sessionsDir: string }) => Promise<void>,
): Promise<void> {
  const previousHook = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  if (hookPath) process.env.AGENT_DEVICE_HTTP_AUTH_HOOK = hookPath;
  else delete process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;

  const stateDir = mkdtempForTestSync('agent-device-tenant-trust-diagnostics-');
  const sessionsDir = path.join(stateDir, 'sessions');
  const server = await createDaemonHttpServer({
    token: DAEMON_TOKEN,
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
    restoreEnv('AGENT_DEVICE_HTTP_AUTH_HOOK', previousHook);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function writeDiagnosticsRecord(sessionsDir: string, session: string, requestId: string): void {
  const recordPath = resolveSessionRequestLogPath(
    path.join(sessionsDir, safeSessionName(session)),
    requestId,
  );
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, DIAGNOSTICS_RECORD);
}

function diagnosticsUrl(baseUrl: string, session: string, requestId: string): string {
  return `${baseUrl}/sessions/${encodeURIComponent(session)}/requests/${encodeURIComponent(requestId)}/diagnostics`;
}

test('RPC: a hook configured but silent on tenant refuses a client-declared meta.tenantId', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const root = mkdtempForTestSync('agent-device-tenant-trust-rpc-');
  try {
    const hookPath = writeSilentAuthHook(root);
    await withRpcServer(hookPath, async ({ baseUrl, observedRequests }) => {
      const response = await callRpc(baseUrl, {
        jsonrpc: '2.0',
        id: 'rpc-impersonate',
        method: 'agent_device.command',
        params: {
          command: 'session_list',
          positionals: [],
          meta: { tenantId: 'victim' },
        },
      });
      assert.equal(response.status, 401);
      assert.equal(response.body.error?.code, -32001);
      assert.equal(
        observedRequests.length,
        0,
        'the handler must never see the impersonated request',
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RPC: a hook configured but silent on tenant refuses a client-declared lease tenantId', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const root = mkdtempForTestSync('agent-device-tenant-trust-rpc-lease-');
  try {
    const hookPath = writeSilentAuthHook(root);
    await withRpcServer(hookPath, async ({ baseUrl, observedRequests }) => {
      const response = await callRpc(baseUrl, {
        jsonrpc: '2.0',
        id: 'rpc-impersonate-lease',
        method: 'agent_device.lease.allocate',
        params: {
          tenantId: 'victim',
          runId: 'run-1',
          ttlMs: 60000,
          backend: 'android-instance',
        },
      });
      assert.equal(response.status, 401);
      assert.equal(response.body.error?.code, -32001);
      assert.equal(
        observedRequests.length,
        0,
        'the handler must never see the impersonated request',
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RPC: a hook configured but silent on tenant refuses a client-declared flags.tenant', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const root = mkdtempForTestSync('agent-device-tenant-trust-rpc-flags-');
  try {
    const hookPath = writeSilentAuthHook(root);
    await withRpcServer(hookPath, async ({ baseUrl, observedRequests }) => {
      const response = await callRpc(baseUrl, {
        jsonrpc: '2.0',
        id: 'rpc-impersonate-flags',
        method: 'agent_device.command',
        params: {
          command: 'session_list',
          positionals: [],
          flags: { tenant: 'victim', sessionIsolation: 'tenant' },
        },
      });
      assert.equal(response.status, 401);
      assert.equal(response.body.error?.code, -32001);
      assert.equal(
        observedRequests.length,
        0,
        'the handler must never see the impersonated request',
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RPC: a hook configured but silent on tenant refuses a request declaring no tenant at all', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const root = mkdtempForTestSync('agent-device-tenant-trust-rpc-omitted-');
  try {
    const hookPath = writeSilentAuthHook(root);
    await withRpcServer(hookPath, async ({ baseUrl, observedRequests }) => {
      const response = await callRpc(baseUrl, {
        jsonrpc: '2.0',
        id: 'rpc-omitted-tenant',
        method: 'agent_device.command',
        params: {
          command: 'session_list',
          positionals: [],
        },
      });
      assert.equal(response.status, 401);
      assert.equal(response.body.error?.code, -32001);
      assert.equal(
        observedRequests.length,
        0,
        'the handler must never see an unscoped request once a hook is configured',
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RPC: a hook that attests a tenant wins over a mismatched client-declared meta.tenantId', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const root = mkdtempForTestSync('agent-device-tenant-trust-rpc-attest-');
  try {
    const hookPath = writeAttestingAuthHook(root);
    await withRpcServer(hookPath, async ({ baseUrl, observedRequests }) => {
      const response = await callRpc(baseUrl, {
        jsonrpc: '2.0',
        id: 'rpc-attested',
        method: 'agent_device.command',
        params: {
          command: 'session_list',
          positionals: [],
          meta: { tenantId: 'victim' },
        },
      });
      assert.equal(response.status, 200);
      assert.equal(observedRequests[0]?.meta?.tenantId, ATTESTED_TENANT_ID);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RPC: a hook that attests a tenant overwrites a mismatched client-declared flags.tenant', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const root = mkdtempForTestSync('agent-device-tenant-trust-rpc-attest-flags-');
  try {
    const hookPath = writeAttestingAuthHook(root);
    await withRpcServer(hookPath, async ({ baseUrl, observedRequests }) => {
      const response = await callRpc(baseUrl, {
        jsonrpc: '2.0',
        id: 'rpc-attested-flags',
        method: 'agent_device.command',
        params: {
          command: 'session_list',
          positionals: [],
          flags: { tenant: 'victim', sessionIsolation: 'tenant' },
        },
      });
      assert.equal(response.status, 200);
      assert.equal(observedRequests[0]?.meta?.tenantId, ATTESTED_TENANT_ID);
      assert.equal(
        observedRequests[0]?.flags?.tenant,
        ATTESTED_TENANT_ID,
        'the flag must not survive as a second, unattested route to identity',
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RPC: no hook configured keeps a client-declared meta.tenantId unchanged (regression)', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  await withRpcServer(undefined, async ({ baseUrl, observedRequests }) => {
    const response = await callRpc(baseUrl, {
      jsonrpc: '2.0',
      id: 'rpc-loopback',
      method: 'agent_device.command',
      params: {
        command: 'session_list',
        positionals: [],
        meta: { tenantId: 'tenant-x' },
      },
    });
    assert.equal(response.status, 200);
    assert.equal(observedRequests[0]?.meta?.tenantId, 'tenant-x');
  });
});

test('RPC: no hook configured keeps a client-declared flags.tenant unchanged (regression)', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  await withRpcServer(undefined, async ({ baseUrl, observedRequests }) => {
    const response = await callRpc(baseUrl, {
      jsonrpc: '2.0',
      id: 'rpc-loopback-flags',
      method: 'agent_device.command',
      params: {
        command: 'session_list',
        positionals: [],
        flags: { tenant: 'tenant-x', sessionIsolation: 'tenant' },
      },
    });
    assert.equal(response.status, 200);
    assert.equal(observedRequests[0]?.meta?.tenantId, 'tenant-x');
    assert.equal(observedRequests[0]?.flags?.tenant, 'tenant-x');
  });
});

test('aux route: a hook configured but silent on tenant refuses a client-declared header claiming another tenant', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const root = mkdtempForTestSync('agent-device-tenant-trust-aux-');
  try {
    const hookPath = writeSilentAuthHook(root);
    await withDiagnosticsHookServer(hookPath, async ({ baseUrl, sessionsDir }) => {
      writeDiagnosticsRecord(sessionsDir, 'victim-tenant:default', 'abc123');
      const response = await fetch(diagnosticsUrl(baseUrl, 'victim-tenant:default', 'abc123'), {
        headers: {
          authorization: `Bearer ${DAEMON_TOKEN}`,
          [DAEMON_HTTP_TENANT_HEADER]: 'victim-tenant',
        },
      });
      assert.equal(response.status, 401);
      assert.equal((await response.text()).includes('request_start'), false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aux route: a hook configured but silent on tenant refuses an omitted header reading a tenant-owned session', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const root = mkdtempForTestSync('agent-device-tenant-trust-aux-omitted-');
  try {
    const hookPath = writeSilentAuthHook(root);
    await withDiagnosticsHookServer(hookPath, async ({ baseUrl, sessionsDir }) => {
      writeDiagnosticsRecord(sessionsDir, 'victim-tenant:default', 'abc123');
      const response = await fetch(diagnosticsUrl(baseUrl, 'victim-tenant:default', 'abc123'), {
        headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
      });
      assert.equal(response.status, 401);
      assert.equal(
        (await response.text()).includes('request_start'),
        false,
        'an unscoped caller must not read a tenant-owned session by naming it directly',
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aux route: a hook that attests a tenant wins over a mismatched client-declared header', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const root = mkdtempForTestSync('agent-device-tenant-trust-aux-attest-');
  try {
    const hookPath = writeAttestingAuthHook(root);
    await withDiagnosticsHookServer(hookPath, async ({ baseUrl, sessionsDir }) => {
      writeDiagnosticsRecord(sessionsDir, `${ATTESTED_TENANT_ID}:default`, 'abc123');
      const owner = await fetch(
        diagnosticsUrl(baseUrl, `${ATTESTED_TENANT_ID}:default`, 'abc123'),
        {
          headers: {
            authorization: `Bearer ${DAEMON_TOKEN}`,
            [DAEMON_HTTP_TENANT_HEADER]: 'victim-tenant',
          },
        },
      );
      assert.equal(owner.status, 200);
      assert.equal(await owner.text(), DIAGNOSTICS_RECORD);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aux route: no hook configured keeps the header-declared tenant unchanged (regression)', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  await withDiagnosticsHookServer(undefined, async ({ baseUrl, sessionsDir }) => {
    writeDiagnosticsRecord(sessionsDir, 'tenant-a:default', 'abc123');
    const owner = await fetch(diagnosticsUrl(baseUrl, 'tenant-a:default', 'abc123'), {
      headers: {
        authorization: `Bearer ${DAEMON_TOKEN}`,
        [DAEMON_HTTP_TENANT_HEADER]: 'tenant-a',
      },
    });
    assert.equal(owner.status, 200);
    const otherTenant = await fetch(diagnosticsUrl(baseUrl, 'tenant-a:default', 'abc123'), {
      headers: {
        authorization: `Bearer ${DAEMON_TOKEN}`,
        [DAEMON_HTTP_TENANT_HEADER]: 'tenant-b',
      },
    });
    assert.equal(otherTenant.status, 401);
  });
});

test('aux route (upload): a hook configured but silent on tenant refuses a client-declared header', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const root = mkdtempForTestSync('agent-device-tenant-trust-upload-');
  const previousHook = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  process.env.AGENT_DEVICE_HTTP_AUTH_HOOK = writeSilentAuthHook(root);
  const server = await createDaemonHttpServer({
    token: DAEMON_TOKEN,
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
  });
  try {
    const port = await listenOnLoopback(server);
    const response = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${DAEMON_TOKEN}`,
        [DAEMON_HTTP_TENANT_HEADER]: 'victim-tenant',
        'x-artifact-type': 'file',
        'x-artifact-filename': 'demo.apk',
        'content-type': 'application/octet-stream',
      },
      body: Buffer.from('fake-apk'),
    });
    assert.equal(response.status, 401);
  } finally {
    await closeLoopbackServer(server);
    restoreEnv('AGENT_DEVICE_HTTP_AUTH_HOOK', previousHook);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RPC: a whitespace-only meta.tenantId is refused the same as any other unattested request under a silent hook', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const root = mkdtempForTestSync('agent-device-tenant-trust-rpc-blank-');
  try {
    const hookPath = writeSilentAuthHook(root);
    await withRpcServer(hookPath, async ({ baseUrl, observedRequests }) => {
      const response = await callRpc(baseUrl, {
        jsonrpc: '2.0',
        id: 'rpc-blank-tenant',
        method: 'agent_device.command',
        params: {
          command: 'session_list',
          positionals: [],
          meta: { tenantId: '   ' },
        },
      });
      assert.equal(response.status, 401);
      assert.equal(observedRequests.length, 0);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
