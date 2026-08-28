import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDaemonHttpServer } from '../server/http-server.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { cleanupUploadedArtifact, trackUploadedArtifact } from '../artifact-tracking.ts';
import { resolveInstallSource } from '../install-source-resolution.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

type RpcErrorResponse = {
  jsonrpc: string;
  id: unknown;
  error?: { code: number; message: string; data?: { code?: string } };
  result?: unknown;
};

async function withCommandRpcServer(
  run: (
    postRpc: (params: unknown) => Promise<{ status: number; body: RpcErrorResponse }>,
  ) => Promise<void>,
  t: { skip(reason?: string): void },
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t)) return;

  let handlerCalls = 0;
  const handleRequest = async (_req: DaemonRequest): Promise<DaemonResponse> => {
    handlerCalls += 1;
    return { ok: true, data: { ok: true } };
  };
  const server = await createDaemonHttpServer({ handleRequest });

  try {
    const port = await listenOnLoopback(server);
    const postRpc = async (params: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'agent_device.command',
          params,
        }),
      });
      return { status: response.status, body: (await response.json()) as RpcErrorResponse };
    };
    await run(postRpc);
    // The malformed-input cases below must be rejected at the boundary, never dispatched.
    assert.equal(handlerCalls, 0);
  } finally {
    await closeLoopbackServer(server);
  }
}

test('malformed command params (positionals as string) yield 400 / -32602, not 500 / -32000', async (t) => {
  await withCommandRpcServer(async (postRpc) => {
    const { status, body } = await postRpc({ command: 'devices', positionals: 'not-an-array' });

    assert.equal(status, 400);
    assert.equal(body.error?.code, -32602);
    assert.notEqual(body.error?.code, -32000);
    assert.equal(body.error?.data?.code, 'INVALID_ARGS');
    assert.ok(body.error?.message.startsWith('Invalid params:'), body.error?.message);
    // The internal schema path sigil must not leak onto the wire.
    assert.ok(!body.error?.message.includes('$.'), body.error?.message);
  }, t);
});

test('malformed command params (command as number) yield 400 / -32602', async (t) => {
  await withCommandRpcServer(async (postRpc) => {
    const { status, body } = await postRpc({ command: 42 });

    assert.equal(status, 400);
    assert.equal(body.error?.code, -32602);
    assert.equal(body.error?.data?.code, 'INVALID_ARGS');
  }, t);
});

// `DaemonRequest.internal` carries semantics-affecting bits stamped inside the
// daemon — `replayPlanStep` controls recording provenance and
// `observationOnly` suppresses snapshot ref issuance for daemon-composed
// Maestro reads. Two independent allowlists keep both unreachable from the
// HTTP wire: `commandRpcParamsSchema` projects only its eight named fields, and
// `toDaemonRequest` then builds the request field by field. Both would have to
// regress for a caller to stamp these semantics; this pins the resulting
// boundary contract so neither drifts silently.
test('the rpc boundary never accepts internal request fields from the wire', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const received: DaemonRequest[] = [];
  const handleRequest = async (req: DaemonRequest): Promise<DaemonResponse> => {
    received.push(req);
    return { ok: true, data: { ok: true } };
  };
  const server = await createDaemonHttpServer({ handleRequest });

  try {
    const port = await listenOnLoopback(server);
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'agent_device.command',
        params: {
          command: 'snapshot',
          positionals: [],
          internal: {
            observationOnly: true,
            replayPlanStep: true,
            replayTargetGuard: { ref: '@e1' },
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(received.length, 1);
    assert.equal(
      received[0]?.internal,
      undefined,
      'a wire-supplied `internal` must never reach the daemon request',
    );
  } finally {
    await closeLoopbackServer(server);
  }
});

async function withInstallFromSourceRpcServer(
  run: (
    post: (source: unknown) => Promise<{
      status: number;
      body: RpcErrorResponse;
      dispatched: DaemonRequest[];
    }>,
  ) => Promise<void>,
  t: { skip(reason?: string): void },
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const dispatched: DaemonRequest[] = [];
  const handleRequest = async (req: DaemonRequest): Promise<DaemonResponse> => {
    dispatched.push(req);
    return { ok: true, data: { ok: true } };
  };
  const server = await createDaemonHttpServer({ handleRequest, env });

  try {
    const port = await listenOnLoopback(server);
    const post = async (source: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'agent_device.install_from_source',
          params: { platform: 'android', source },
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as RpcErrorResponse,
        dispatched,
      };
    };
    await run(post);
  } finally {
    await closeLoopbackServer(server);
  }
}

test('install_from_source rejects a host path source at the rpc boundary', async (t) => {
  await withInstallFromSourceRpcServer(async (post) => {
    const { status, body, dispatched } = await post({ kind: 'path', path: '/etc/passwd' });

    assert.equal(status, 400);
    assert.equal(body.error?.code, -32602);
    assert.equal(body.error?.data?.code, 'INVALID_ARGS');
    assert.equal(dispatched.length, 0, 'a host path source must never reach the handler');
  }, t);
});

test('install_from_source still admits url sources', async (t) => {
  await withInstallFromSourceRpcServer(async (post) => {
    const { status, dispatched } = await post({ kind: 'url', url: 'https://example.com/app.apk' });

    assert.equal(status, 200);
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0]?.meta?.installSource, {
      kind: 'url',
      url: 'https://example.com/app.apk',
    });
  }, t);
});

test('install_from_source still admits github-actions-artifact sources', async (t) => {
  await withInstallFromSourceRpcServer(async (post) => {
    const { status, dispatched } = await post({
      kind: 'github-actions-artifact',
      owner: 'callstack',
      repo: 'agent-device',
      artifactId: 42,
    });

    assert.equal(status, 200);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.meta?.installSource?.kind, 'github-actions-artifact');
  }, t);
});

test('remote HTTP rejects host path install sources in the command RPC used by the CLI', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const root = mkdtempForTestSync('agent-device-http-command-path-default-');
  const hookPath = writeAllowingAuthHook(root);
  let handlerCalls = 0;
  const server = await createDaemonHttpServer({
    env: remoteHttpEnvironment(hookPath),
    handleRequest: async (): Promise<DaemonResponse> => {
      handlerCalls += 1;
      return { ok: true, data: {} };
    },
  });

  try {
    const port = await listenOnLoopback(server);
    const response = await postCommandRpc(port, {
      command: 'install_source',
      positionals: [],
      flags: { platform: 'android' },
      meta: {
        installSource: { kind: 'path', path: path.join(root, 'app.apk') },
      },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error?.code, -32602);
    assert.equal(response.body.error?.data?.code, 'INVALID_ARGS');
    assert.match(response.body.error?.message ?? '', /disabled on the remote HTTP surface/);
    assert.equal(handlerCalls, 0);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('remote HTTP accepts an uploaded path artifact without resolving the client path', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const root = mkdtempForTestSync('agent-device-http-uploaded-path-');
  const artifactPath = path.join(root, 'uploaded.apk');
  fs.writeFileSync(artifactPath, 'uploaded');
  const uploadedArtifactId = trackUploadedArtifact({ artifactPath, tempDir: root });
  const hookPath = writeAllowingAuthHook(root);
  const received: DaemonRequest[] = [];
  const server = await createDaemonHttpServer({
    env: remoteHttpEnvironment(hookPath),
    handleRequest: async (request): Promise<DaemonResponse> => {
      received.push(request);
      const resolved = resolveInstallSource(request);
      try {
        assert.equal(resolved.source.kind, 'path');
        assert.equal(resolved.source.path, artifactPath);
      } finally {
        resolved.cleanup();
      }
      return { ok: true, data: {} };
    },
  });

  try {
    const port = await listenOnLoopback(server);
    const response = await postCommandRpc(port, {
      command: 'install_source',
      positionals: [],
      flags: { platform: 'android' },
      meta: {
        installSource: { kind: 'path', path: '/etc/hosts' },
        uploadedArtifactId,
      },
    });
    assert.equal(response.status, 200);
    assert.equal(received.length, 1);
  } finally {
    await closeLoopbackServer(server);
    cleanupUploadedArtifact(uploadedArtifactId);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local command RPC keeps host paths unrestricted', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const received: DaemonRequest[] = [];
  const server = await createDaemonHttpServer({
    env: localHttpEnvironment(),
    handleRequest: async (request): Promise<DaemonResponse> => {
      received.push(request);
      return { ok: true, data: {} };
    },
  });

  try {
    const port = await listenOnLoopback(server);
    const response = await postCommandRpc(port, {
      command: 'install_source',
      positionals: [],
      flags: { platform: 'android' },
      meta: { installSource: { kind: 'path', path: '/tmp/local.apk' } },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received[0]?.meta?.installSource, {
      kind: 'path',
      path: '/tmp/local.apk',
    });
    assert.equal(received[0]?.internal, undefined);
  } finally {
    await closeLoopbackServer(server);
  }
});

function writeAllowingAuthHook(root: string): string {
  const hookPath = path.join(root, 'auth-hook.mjs');
  fs.writeFileSync(hookPath, "export default () => ({ tenantId: 'tenant-test' });\n");
  return hookPath;
}

function remoteHttpEnvironment(hookPath: string): NodeJS.ProcessEnv {
  const env = localHttpEnvironment();
  env.AGENT_DEVICE_HTTP_AUTH_HOOK = hookPath;
  return env;
}

function localHttpEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  delete env.AGENT_DEVICE_HTTP_AUTH_EXPORT;
  return env;
}

async function postCommandRpc(
  port: number,
  params: Record<string, unknown>,
): Promise<{ status: number; body: RpcErrorResponse }> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'command-install-source',
      method: 'agent_device.command',
      params,
    }),
  });
  return { status: response.status, body: (await response.json()) as RpcErrorResponse };
}
