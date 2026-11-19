import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { createDaemonHttpServer } from '../http/http-server.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const TOKEN = 'daemon-secret';
const SIZE_BYTES = 64 * 1024 * 1024;

async function withIO<T>(pending: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timeout = realSetTimeout(() => reject(new Error(`${label} did not complete in 3s`)), 3_000);
  });
  try {
    return await Promise.race([pending, guard]);
  } finally {
    realClearTimeout(timeout);
  }
}

async function flushIO(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await new Promise((r) => setImmediate(r));
}

async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const server = await createDaemonHttpServer({
    token: TOKEN,
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    env,
    cwd: process.cwd(),
  });
  return { server, port: await listenOnLoopback(server) };
}

async function preflight(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/upload/preflight`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      sha256: 'a'.repeat(64),
      uploadAttemptId: crypto.randomUUID(),
      fileName: 'artifact.bin',
      sizeBytes: SIZE_BYTES,
      artifactType: 'file',
    }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { uploadId: string }).uploadId;
}

/**
 * Two pipelined PUTs on one keep-alive socket: the first carries a full 2-byte chunk, the
 * second starts at offset 0 again and keeps streaming. After the second answer arrives,
 * the client sends 16 MiB more, as a client that has not read its answer yet would, and
 * then ends. Resolves with the second answer once the socket closes cleanly, and rejects
 * when the server resets the connection.
 */
function pipelinedUploads(port: number, uploadId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const headers = `Host: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n`;
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const framedChunk = Buffer.concat([
      Buffer.from(`${chunk.length.toString(16)}\r\n`),
      chunk,
      Buffer.from('\r\n'),
    ]);
    let received = '';
    let answer: string | undefined;
    let sentAfterAnswer = 0;
    const findSecondAnswer = () => {
      const starts = [...received.matchAll(/HTTP\/1\.1 /g)].map((match) => match.index ?? 0);
      if (starts.length < 2) return undefined;
      const end = received.indexOf('\r\n\r\n', starts[1]);
      return end === -1 ? undefined : received.slice(starts[1], end);
    };
    socket.on('data', (data: Buffer) => {
      received += data.toString('latin1');
      answer ??= findSecondAnswer();
    });
    socket.on('error', reject);
    socket.on('close', (hadError) => {
      if (hadError) return;
      if (answer === undefined) reject(new Error('socket closed before the second answer'));
      else resolve(answer);
    });
    socket.write(
      `PUT /upload/direct/${uploadId} HTTP/1.1\r\n${headers}Content-Range: bytes 0-1/${SIZE_BYTES}\r\nContent-Length: 2\r\n\r\nAB` +
        `PUT /upload/direct/${uploadId} HTTP/1.1\r\n${headers}Transfer-Encoding: chunked\r\n\r\n`,
    );
    let sent = 0;
    const pump = () => {
      while (sent < SIZE_BYTES && sentAfterAnswer < 16 * 1024 * 1024 && socket.writable) {
        sent += chunk.length;
        if (answer !== undefined) sentAfterAnswer += chunk.length;
        if (!socket.write(framedChunk)) {
          socket.once('drain', pump);
          return;
        }
      }
      if (socket.writable) socket.end();
    };
    pump();
  });
}

test('the second of two pipelined uploads reads its early 308 while it is still streaming', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  try {
    // A reset on close with unread body bytes is timing dependent, so the case repeats.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const uploadId = await withIO(preflight(port), 'the preflight');
      const answer = await withIO(pipelinedUploads(port, uploadId), 'the second 308 answer');
      assert.match(answer, /^HTTP\/1\.1 308 /);
      assert.match(answer, /\r\nx-upload-offset: 2\r\n/i);
      assert.match(answer, /\r\nconnection: close\r\n/i);
    }
  } finally {
    await closeLoopbackServer(server);
  }
});

type HeldHookCall = { signal?: AbortSignal };
const HELD_HOOK_CALLS = '__agentDeviceHeldUploadAuthHook';

function heldHookCalls(): HeldHookCall[] {
  const store = globalThis as Record<string, unknown>;
  store[HELD_HOOK_CALLS] ??= [];
  return store[HELD_HOOK_CALLS] as HeldHookCall[];
}

async function startHeldHookServer() {
  const dir = mkdtempForTestSync('agent-device-held-auth-hook-');
  const hookPath = path.join(dir, 'held-hook.mjs');
  // The hook never answers: it stands for an identity service that hangs.
  fs.writeFileSync(
    hookPath,
    `export default (context) => {
      const calls = (globalThis[${JSON.stringify(HELD_HOOK_CALLS)}] ??= []);
      calls.push({ signal: context.signal });
      return new Promise(() => {});
    };\n`,
  );
  heldHookCalls().length = 0;
  return await startServer({ ...process.env, AGENT_DEVICE_HTTP_AUTH_HOOK: hookPath });
}

async function waitForHookCall(): Promise<HeldHookCall> {
  for (let i = 0; i < 50 && heldHookCalls().length === 0; i += 1) await flushIO();
  const [call] = heldHookCalls();
  assert.ok(call, 'the auth hook was called');
  return call;
}

test('a held auth hook sees the upload ingress deadline through its signal', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startHeldHookServer();
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'PUT',
      path: '/upload/direct/held',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-length': '2' },
    });
    const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
      req.on('response', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
    });
    void answer.catch(() => {});
    req.end('AB');
    const call = await waitForHookCall();
    // The body stays unread behind the held hook, so the 120 s inactivity ceiling fires.
    await vi.advanceTimersByTimeAsync(120_000);
    assert.equal(call.signal?.aborted, true, 'the hook signal aborts at the deadline');
    const reason = call.signal?.reason as AppError | undefined;
    assert.equal(reason instanceof AppError, true);
    assert.equal(reason?.details?.reason, 'transfer_phase_timeout');
    // The route's wait on the hook settles: the exchange ends with the typed answer.
    const answered = await withIO(answer, 'the typed answer behind the held hook');
    assert.equal(answered.status, 500);
    assert.equal(JSON.parse(answered.body).reason, 'transfer_phase_timeout');
  } finally {
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('a held auth hook sees a client disconnect through its signal', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startHeldHookServer();
  try {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/upload/preflight',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    });
    req.on('error', () => {});
    req.end('{}');
    const call = await waitForHookCall();
    req.destroy();
    for (let i = 0; i < 50 && !call.signal?.aborted; i += 1) await flushIO();
    assert.equal(call.signal?.aborted, true, 'the hook signal aborts on disconnect');
    const reason = call.signal?.reason as AppError | undefined;
    assert.equal(reason?.details?.reason, 'request_canceled');
  } finally {
    await closeLoopbackServer(server);
  }
});
