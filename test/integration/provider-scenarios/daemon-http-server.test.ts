import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '../../../src/kernel/errors.ts';
import {
  cleanupUploadedArtifact,
  prepareUploadedArtifact,
  trackDownloadableArtifact,
} from '../../../src/daemon/artifact-tracking.ts';
import { DAEMON_RPC_PROTOCOL_VERSION } from '../../../src/daemon/http-health.ts';
import { createDaemonHttpServer } from '../../../src/daemon/server/http-server.ts';
import { emitRequestProgress } from '../../../src/daemon/request-progress.ts';
import { getRequestSignal, isRequestCanceled } from '../../../src/daemon/request-cancel.ts';
import type { DaemonRequest, DaemonResponse } from '../../../src/daemon/types.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';
import { restoreEnv } from './harness.ts';

type RpcResponse = {
  status: number;
  body: {
    result?: DaemonResponse;
    error?: {
      code: number;
      message: string;
      data?: Record<string, unknown>;
    };
  };
};

type JsonRpcResponseEnvelope = {
  type: 'response';
  response: {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: DaemonResponse;
    error?: {
      code: number;
      message: string;
      data?: Record<string, unknown>;
    };
  };
};

const RPC_BODY_CAP_BYTES = 1024 * 1024;

test('Provider-backed integration daemon HTTP server maps RPC methods, auth, and request cancellation through the real transport', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP integration coverage')) {
    return;
  }

  const observedRequests: DaemonRequest[] = [];
  let observedCanceled: boolean | undefined;
  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (req): Promise<DaemonResponse> => {
      observedRequests.push(req);
      if (req.command === 'session_list') {
        await new Promise((resolve) => setTimeout(resolve, 25));
        observedCanceled = isRequestCanceled(req.meta?.requestId);
      }
      if (req.command === 'fail_me') {
        throw new AppError('INVALID_ARGS', 'real transport rejected the request', {
          command: req.command,
        });
      }
      return {
        ok: true,
        data: {
          command: req.command,
          session: req.session,
          meta: req.meta,
          flags: req.flags,
        },
      };
    },
  });

  try {
    const port = await listenOnLoopback(server);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const healthPayload = (await health.json()) as Record<string, unknown>;
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.service, 'agent-device-daemon');
    assert.equal(typeof healthPayload.version, 'string');
    assert.equal(healthPayload.rpcProtocolVersion, DAEMON_RPC_PROTOCOL_VERSION);

    const command = await callRpc(port, {
      jsonrpc: '2.0',
      id: 'rpc-command',
      method: 'agent_device.command',
      params: {
        session: 'default',
        command: 'session_list',
        positionals: [],
        meta: { requestId: 'req-command' },
      },
    });
    assert.equal(command.status, 200);
    assert.equal(command.body.result?.ok, true);
    assert.equal(observedCanceled, false);

    const installFromUrl = await callRpc(port, {
      jsonrpc: '2.0',
      id: 'rpc-install-url',
      method: 'agent_device.install_from_source',
      params: {
        session: 'bootstrap',
        platform: 'android',
        requestId: 'req-install-url',
        retainPaths: true,
        retentionMs: 30000,
        source: {
          kind: 'url',
          url: 'https://example.com/app.apk',
          headers: { authorization: 'Bearer signed-token' },
        },
      },
    });
    assert.equal(installFromUrl.status, 200);

    const installFromGitHub = await callRpc(port, {
      jsonrpc: '2.0',
      id: 'rpc-install-github',
      method: 'agent_device.install_from_source',
      params: {
        session: 'bootstrap',
        platform: 'ios',
        source: {
          kind: 'github-actions-artifact',
          owner: 'acme',
          repo: 'mobile',
          runId: '1234567890',
          artifactName: 'ios-debug',
        },
      },
    });
    assert.equal(installFromGitHub.status, 200);

    const lease = await callRpc(port, {
      jsonrpc: '2.0',
      id: 'rpc-lease',
      method: 'agent_device.lease.allocate',
      params: {
        tenantId: 'Tenant A',
        runId: 'run-1',
        ttlMs: 60000,
        backend: 'android-instance',
      },
    });
    assert.equal(lease.status, 200);

    const release = await callRpc(port, {
      jsonrpc: '2.0',
      id: 'rpc-release',
      method: 'agent_device.release_materialized_paths',
      params: {
        session: 'bootstrap',
        requestId: 'req-release',
        materializationId: 'materialized-1',
      },
    });
    assert.equal(release.status, 200);

    const failure = await callRpc(port, {
      jsonrpc: '2.0',
      id: 'rpc-failure',
      method: 'agent_device.command',
      params: {
        command: 'fail_me',
        positionals: [],
      },
    });
    assert.equal(failure.status, 400);
    assert.equal(failure.body.error?.data?.code, 'INVALID_ARGS');
    assert.equal(
      (failure.body.error?.data?.details as Record<string, unknown> | undefined)?.command,
      'fail_me',
    );

    const unsupported = await callRpc(port, {
      jsonrpc: '2.0',
      id: 'rpc-missing',
      method: 'agent_device.missing',
      params: {},
    });
    assert.equal(unsupported.status, 404);
    assert.equal(unsupported.body.error?.code, -32601);

    const installUrlRequest = observedRequests.find(
      (req) => req.meta?.requestId === 'req-install-url',
    );
    assert.equal(installUrlRequest?.command, 'install_source');
    assert.equal(installUrlRequest?.session, 'bootstrap');
    assert.equal(installUrlRequest?.flags?.platform, 'android');
    assert.equal(installUrlRequest?.meta?.retainMaterializedPaths, true);
    assert.equal(installUrlRequest?.meta?.materializedPathRetentionMs, 30000);
    assert.deepEqual(installUrlRequest?.meta?.installSource, {
      kind: 'url',
      url: 'https://example.com/app.apk',
      headers: { authorization: 'Bearer signed-token' },
    });

    const githubRequest = observedRequests.find(
      (req) => req.command === 'install_source' && req.flags?.platform === 'ios',
    );
    assert.deepEqual(githubRequest?.meta?.installSource, {
      kind: 'github-actions-artifact',
      owner: 'acme',
      repo: 'mobile',
      runId: 1234567890,
      artifactName: 'ios-debug',
    });

    const leaseRequest = observedRequests.find((req) => req.command === 'lease_allocate');
    assert.equal(leaseRequest?.meta?.tenantId, 'Tenant A');
    assert.equal(leaseRequest?.meta?.leaseTtlMs, 60000);
    assert.equal(leaseRequest?.meta?.leaseBackend, 'android-instance');

    const releaseRequest = observedRequests.find(
      (req) => req.command === 'release_materialized_paths',
    );
    assert.equal(releaseRequest?.meta?.materializationId, 'materialized-1');
  } finally {
    await closeLoopbackServer(server);
  }
});

test('Provider-backed integration daemon HTTP server cancels progress streams when the client disconnects', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP integration coverage')) {
    return;
  }

  const requestId = 'req-http-progress-cancel';
  let observedCanceledDuringAbort: boolean | undefined;
  let handlerError: unknown;
  let resolveHandlerDone: () => void = () => {};
  const handlerDone = new Promise<void>((resolve) => {
    resolveHandlerDone = resolve;
  });
  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (req): Promise<DaemonResponse> => {
      try {
        assert.equal(req.meta?.requestId, requestId);
        emitRequestProgress({
          type: 'replay-test',
          file: 'cancel.ad',
          status: 'pass',
          index: 1,
          total: 1,
        });

        const signal = getRequestSignal(requestId);
        assert.ok(signal, 'request abort signal should be registered during streaming');
        await waitForAbort(signal);
        observedCanceledDuringAbort = isRequestCanceled(requestId);
        return { ok: true, data: { canceled: observedCanceledDuringAbort } };
      } catch (error) {
        handlerError = error;
        throw error;
      } finally {
        resolveHandlerDone();
      }
    },
  });

  try {
    const port = await listenOnLoopback(server);
    await withTimeout(
      Promise.all([
        abortStreamingRpcAfterFirstChunk(port, {
          jsonrpc: '2.0',
          id: 'rpc-cancel-progress',
          method: 'agent_device.command',
          params: {
            command: 'session_list',
            meta: { requestId, requestProgress: 'replay-test' },
          },
        }),
        handlerDone,
      ]),
      'streaming request cancellation',
    );
    if (handlerError) throw handlerError;

    assert.equal(observedCanceledDuringAbort, true);
    assert.equal(isRequestCanceled(requestId), false);
    assert.equal(getRequestSignal(requestId), undefined);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('Provider-backed integration daemon HTTP server destroys oversized RPC request bodies', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP integration coverage')) {
    return;
  }

  let handled = false;
  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (): Promise<DaemonResponse> => {
      handled = true;
      return { ok: true, data: {} };
    },
  });

  try {
    const port = await listenOnLoopback(server);
    const oversizedBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-body-cap',
      method: 'agent_device.command',
      params: {
        command: 'session_list',
        padding: 'x'.repeat(RPC_BODY_CAP_BYTES),
      },
    });
    assert.ok(oversizedBody.length > RPC_BODY_CAP_BYTES);

    const outcome = await sendRawRpcBody(port, oversizedBody);
    assert.equal(handled, false);
    if (outcome.kind === 'response') {
      assert.equal(outcome.status, 400);
      assert.equal(JSON.parse(outcome.body).error.code, -32700);
    } else {
      assert.match(outcome.message, /aborted|reset|socket hang up|request too large/i);
    }

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('Provider-backed integration daemon HTTP server validates malformed JSON-RPC envelopes', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP integration coverage')) {
    return;
  }

  let handled = false;
  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (): Promise<DaemonResponse> => {
      handled = true;
      return { ok: true, data: {} };
    },
  });

  try {
    const port = await listenOnLoopback(server);
    const cases = [
      {
        name: 'invalid JSON',
        body: '{"jsonrpc":"2.0"',
        status: 400,
        code: -32700,
      },
      {
        name: 'missing jsonrpc',
        body: JSON.stringify({
          id: 'rpc-missing-jsonrpc',
          method: 'agent_device.command',
          params: { command: 'session_list' },
        }),
        status: 400,
        code: -32600,
      },
      {
        name: 'unknown method',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'rpc-unknown-method',
          method: 'agent_device.nope',
          params: {},
        }),
        status: 404,
        code: -32601,
      },
      {
        name: 'non-object params',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'rpc-non-object-params',
          method: 'agent_device.command',
          params: 'session_list',
        }),
        status: 400,
        code: -32602,
      },
    ];

    for (const testCase of cases) {
      const response = await callRawRpc(port, testCase.body);
      assert.equal(response.status, testCase.status, testCase.name);
      assert.equal(response.body.error?.code, testCase.code, testCase.name);
    }
    assert.equal(handled, false);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('Provider-backed integration daemon HTTP server writes error envelopes after streaming headers are sent', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP integration coverage')) {
    return;
  }

  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (): Promise<DaemonResponse> => {
      emitRequestProgress({
        type: 'replay-test',
        file: 'headers-sent.ad',
        status: 'fail',
        index: 1,
        total: 1,
        message: 'progress before failure',
      });
      throw new AppError('COMMAND_FAILED', 'stream failed after headers');
    },
  });

  try {
    const port = await listenOnLoopback(server);
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer provider-scenario-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'rpc-stream-error',
        method: 'agent_device.command',
        params: {
          command: 'test',
          meta: { requestId: 'req-stream-error', requestProgress: 'replay-test' },
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
    const envelopes = parseNdjson(await response.text());
    assert.equal(envelopes.length, 2);
    assert.equal(envelopes[0]?.type, 'progress');
    const terminal = envelopes[1] as JsonRpcResponseEnvelope;
    assert.equal(terminal.type, 'response');
    assert.equal(terminal.response.error?.code, -32000);
    assert.equal(terminal.response.error?.data?.code, 'COMMAND_FAILED');
    assert.equal(terminal.response.error?.message, 'stream failed after headers');
  } finally {
    await closeLoopbackServer(server);
  }
});

test('Provider-backed integration daemon HTTP server accepts uploads and streams downloadable artifacts', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP integration coverage')) {
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-http-server-'));
  const downloadablePath = path.join(root, 'screen.png');
  fs.writeFileSync(downloadablePath, 'png-binary');
  const artifactId = trackDownloadableArtifact({
    artifactPath: downloadablePath,
    fileName: 'screen.png',
  });
  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
  });

  try {
    const port = await listenOnLoopback(server);

    const upload = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer provider-scenario-token',
        'x-artifact-type': 'file',
        'x-artifact-filename': 'demo.apk',
        'content-type': 'application/octet-stream',
      },
      body: Buffer.from('fake-apk'),
    });
    assert.equal(upload.status, 200);
    const uploadBody = (await upload.json()) as { ok?: boolean; uploadId?: string };
    assert.equal(uploadBody.ok, true);
    assert.equal(typeof uploadBody.uploadId, 'string');

    const downloaded = await fetch(`http://127.0.0.1:${port}/artifacts/${artifactId}`, {
      headers: { authorization: 'Bearer provider-scenario-token' },
    });
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), 'png-binary');
    assert.match(downloaded.headers.get('content-disposition') ?? '', /screen\.png/);

    const rejectedUpload = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
        'x-artifact-type': 'file',
        'x-artifact-filename': 'demo.apk',
      },
      body: Buffer.from('fake-apk'),
    });
    assert.equal(rejectedUpload.status, 401);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Provider-backed integration daemon HTTP server resumes direct uploads before finalize', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP integration coverage')) {
    return;
  }

  const content = Buffer.from('fake-apk-resumable-content');
  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
  });
  let trackedUploadId = '';

  try {
    const port = await listenOnLoopback(server);
    const preflight = await fetch(`http://127.0.0.1:${port}/upload/preflight`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer provider-scenario-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        uploadAttemptId: 'resume-before-finalize',
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        fileName: 'demo.apk',
        sizeBytes: content.length,
        artifactType: 'file',
        platform: 'android',
        contentType: 'application/octet-stream',
      }),
    });
    assert.equal(preflight.status, 200);
    const preflightBody = (await preflight.json()) as {
      uploadId?: string;
      upload?: { url?: string; headers?: Record<string, string> };
    };
    assert.equal(typeof preflightBody.uploadId, 'string');
    assert.equal(typeof preflightBody.upload?.url, 'string');
    if (!preflightBody.upload?.url) throw new Error('missing upload url');
    const uploadUrl = preflightBody.upload.url;
    const uploadHeaders = preflightBody.upload.headers ?? {};

    const firstChunk = await fetch(uploadUrl, {
      method: 'PUT',
      headers: uploadHeaders,
      body: content.subarray(0, 9),
    });
    assert.equal(firstChunk.status, 308);
    assert.equal(firstChunk.headers.get('x-upload-offset'), '9');

    const restartFromZero = await fetch(uploadUrl, {
      method: 'PUT',
      headers: uploadHeaders,
      body: content,
    });
    assert.equal(restartFromZero.status, 308);
    assert.equal(restartFromZero.headers.get('x-upload-offset'), '9');

    const resumed = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        ...uploadHeaders,
        'content-range': `bytes 9-${content.length - 1}/${content.length}`,
      },
      body: content.subarray(9),
    });
    assert.equal(resumed.status, 200);

    const finalize = await fetch(`http://127.0.0.1:${port}/upload/finalize`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer provider-scenario-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ uploadId: preflightBody.uploadId }),
    });
    assert.equal(finalize.status, 200);
    const finalizeBody = (await finalize.json()) as { uploadId?: string };
    trackedUploadId = finalizeBody.uploadId ?? '';
    assert.equal(typeof trackedUploadId, 'string');
    assert.deepEqual(fs.readFileSync(prepareUploadedArtifact(trackedUploadId)), content);
  } finally {
    if (trackedUploadId) cleanupUploadedArtifact(trackedUploadId);
    await closeLoopbackServer(server);
  }
});

test('Provider-backed integration daemon HTTP server isolates same-artifact upload attempts', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP integration coverage')) {
    return;
  }

  const content = Buffer.from('same-apk-content');
  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
  });
  const trackedUploadIds: string[] = [];

  try {
    const port = await listenOnLoopback(server);
    const requestPreflight = async (uploadAttemptId: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/upload/preflight`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer provider-scenario-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          uploadAttemptId,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
          fileName: 'demo.apk',
          sizeBytes: content.length,
          artifactType: 'file',
          platform: 'android',
          contentType: 'application/octet-stream',
        }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        uploadId?: string;
        upload?: { url?: string; headers?: Record<string, string> };
      };
      assert.equal(typeof body.uploadId, 'string');
      assert.equal(typeof body.upload?.url, 'string');
      if (!body.uploadId || !body.upload?.url) throw new Error('missing upload ticket');
      return {
        uploadId: body.uploadId,
        uploadUrl: body.upload.url,
        uploadHeaders: body.upload.headers ?? {},
      };
    };

    const first = await requestPreflight('same-artifact-first');
    const second = await requestPreflight('same-artifact-second');
    assert.notEqual(first.uploadId, second.uploadId);
    assert.notEqual(first.uploadUrl, second.uploadUrl);

    const firstChunk = await fetch(first.uploadUrl, {
      method: 'PUT',
      headers: first.uploadHeaders,
      body: content.subarray(0, 5),
    });
    assert.equal(firstChunk.status, 308);
    assert.equal(firstChunk.headers.get('x-upload-offset'), '5');

    const secondComplete = await fetch(second.uploadUrl, {
      method: 'PUT',
      headers: second.uploadHeaders,
      body: content,
    });
    assert.equal(secondComplete.status, 200);

    const secondFinalize = await finalizeUpload(port, second.uploadId);
    trackedUploadIds.push(secondFinalize);
    assert.deepEqual(fs.readFileSync(prepareUploadedArtifact(secondFinalize)), content);

    const firstComplete = await fetch(first.uploadUrl, {
      method: 'PUT',
      headers: {
        ...first.uploadHeaders,
        'content-range': `bytes 5-${content.length - 1}/${content.length}`,
      },
      body: content.subarray(5),
    });
    assert.equal(firstComplete.status, 200);

    const firstFinalize = await finalizeUpload(port, first.uploadId);
    trackedUploadIds.push(firstFinalize);
    assert.deepEqual(fs.readFileSync(prepareUploadedArtifact(firstFinalize)), content);
  } finally {
    for (const uploadId of trackedUploadIds) cleanupUploadedArtifact(uploadId);
    await closeLoopbackServer(server);
  }
});

test('Provider-backed integration daemon HTTP server reports unknown upload tickets as expired', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP integration coverage')) {
    return;
  }

  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
  });

  try {
    const port = await listenOnLoopback(server);
    const unknownUploadId = crypto.randomUUID();
    const auth = { authorization: 'Bearer provider-scenario-token' };

    const directChunk = await fetch(`http://127.0.0.1:${port}/upload/direct/${unknownUploadId}`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: Buffer.from('late-chunk'),
    });
    assert.equal(directChunk.status, 500);
    const directBody = (await directChunk.json()) as {
      ok?: boolean;
      code?: string;
      error?: string;
    };
    assert.equal(directBody.ok, false);
    assert.equal(directBody.code, 'COMMAND_FAILED');
    assert.match(directBody.error ?? '', /not found or expired/);

    const finalize = await fetch(`http://127.0.0.1:${port}/upload/finalize`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: unknownUploadId }),
    });
    assert.equal(finalize.status, 500);
    const finalizeBody = (await finalize.json()) as {
      ok?: boolean;
      code?: string;
      error?: string;
    };
    assert.equal(finalizeBody.ok, false);
    assert.equal(finalizeBody.code, 'COMMAND_FAILED');
    assert.match(finalizeBody.error ?? '', /not found or expired/);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('Provider-backed integration daemon HTTP auth hook can scope tenants and reject requests', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP integration coverage')) {
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-http-auth-hook-'));
  const hookPath = path.join(root, 'auth-hook.mjs');
  fs.writeFileSync(
    hookPath,
    `export default function authHook({ headers }) {
      if (headers['x-reject'] === 'yes') return { ok: false, code: 'UNAUTHORIZED', message: 'tenant rejected' };
      return { tenantId: headers['x-tenant'] || 'tenant-hook' };
    }`,
  );
  const previousHook = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  process.env.AGENT_DEVICE_HTTP_AUTH_HOOK = hookPath;

  let observedRequest: DaemonRequest | undefined;
  let server: Awaited<ReturnType<typeof createDaemonHttpServer>> | undefined;

  try {
    server = await createDaemonHttpServer({
      handleRequest: async (req): Promise<DaemonResponse> => {
        observedRequest = req;
        return { ok: true, data: { meta: req.meta } };
      },
    });
    const port = await listenOnLoopback(server);
    const accepted = await callRpc(
      port,
      {
        jsonrpc: '2.0',
        id: 'rpc-auth-hook',
        method: 'agent_device.command',
        params: {
          command: 'session_list',
          flags: { sessionIsolation: 'tenant' },
        },
      },
      { 'x-tenant': 'tenant-hook' },
    );
    assert.equal(accepted.status, 200);
    assert.equal(observedRequest?.meta?.tenantId, 'tenant-hook');
    assert.equal(observedRequest?.meta?.sessionIsolation, 'tenant');

    const rejected = await callRpc(
      port,
      {
        jsonrpc: '2.0',
        id: 'rpc-auth-reject',
        method: 'agent_device.command',
        params: {
          command: 'session_list',
        },
      },
      { 'x-reject': 'yes' },
    );
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error?.data?.message, 'tenant rejected');
  } finally {
    if (server) {
      await closeLoopbackServer(server);
    }
    restoreEnv('AGENT_DEVICE_HTTP_AUTH_HOOK', previousHook);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function callRpc(
  port: number,
  payload: Record<string, unknown>,
  headers: Record<string, string> = { authorization: 'Bearer provider-scenario-token' },
): Promise<RpcResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    body: (await response.json()) as RpcResponse['body'],
  };
}

async function finalizeUpload(port: number, uploadId: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/upload/finalize`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer provider-scenario-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ uploadId }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { uploadId?: string };
  const finalizedUploadId = body.uploadId;
  if (typeof finalizedUploadId !== 'string') throw new Error('missing finalized upload id');
  return finalizedUploadId;
}

async function callRawRpc(port: number, body: string): Promise<RpcResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer provider-scenario-token',
      'content-type': 'application/json',
    },
    body,
  });
  return {
    status: response.status,
    body: (await response.json()) as RpcResponse['body'],
  };
}

function abortStreamingRpcAfterFirstChunk(
  port: number,
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let sawChunk = false;
    let settled = false;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          authorization: 'Bearer provider-scenario-token',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.setEncoding('utf8');
        res.once('data', () => {
          sawChunk = true;
          res.destroy();
          req.destroy();
        });
        res.on('close', () => {
          if (sawChunk) settle();
        });
        res.on('error', (error) => {
          if (sawChunk) settle();
          else settle(error);
        });
      },
    );
    req.on('error', (error) => {
      if (sawChunk) settle();
      else settle(error);
    });
    req.end(body);
  });
}

function sendRawRpcBody(
  port: number,
  body: string,
): Promise<
  { kind: 'response'; status: number; body: string } | { kind: 'error'; message: string }
> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          authorization: 'Bearer provider-scenario-token',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.setEncoding('utf8');
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          resolve({ kind: 'response', status: res.statusCode ?? 0, body: responseBody });
        });
        res.on('error', (error) => {
          resolve({ kind: 'error', message: error.message });
        });
      },
    );
    req.on('error', (error) => {
      resolve({ kind: 'error', message: error.message });
    });
    req.end(body);
  });
}

function parseNdjson(body: string): Array<Record<string, unknown>> {
  return body
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label}`));
        }, 1_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
