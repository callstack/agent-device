import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

// The real ingress budget, scaled down: Node's own header and request clocks run on real
// time, so the case shrinks the owner's values instead of faking a clock.
vi.mock('./ingress-budget.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ingress-budget.ts')>()),
  DAEMON_HTTP_HEADERS_TIMEOUT_MS: 400,
  DAEMON_HTTP_CONNECTIONS_CHECKING_INTERVAL_MS: 200,
  UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS: 1_000,
  UPLOAD_AGGREGATE_SOCKET_MARGIN_MS: 50,
}));

const TOKEN = 'daemon-secret';
const SIZE_BYTES = 1024 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('slow headers and a progressing body are answered by the upload owner, not by Node', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { createDaemonHttpServer } = await import('./http-server.ts');
  const server = await createDaemonHttpServer({
    token: TOKEN,
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    env: process.env,
    cwd: process.cwd(),
  });
  const port = await listenOnLoopback(server);
  const socket = net.connect(port, '127.0.0.1');
  try {
    const preflight = await fetch(`http://127.0.0.1:${port}/upload/preflight`, {
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
    assert.equal(preflight.status, 200);
    const { uploadId } = (await preflight.json()) as { uploadId: string };

    let received = '';
    socket.on('data', (data: Buffer) => {
      received += data.toString('latin1');
    });
    socket.on('error', () => {});
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    // The header block arrives slowly, just inside the 400 ms header ceiling, so admission
    // starts about 350 ms after Node's request clock. A ceiling of aggregate plus margin
    // (1050 ms) would let Node close the request before the owner's 1000 ms aggregate.
    const head =
      `PUT /upload/direct/${uploadId} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
      `Authorization: Bearer ${TOKEN}\r\nContent-Range: bytes 0-${SIZE_BYTES - 1}/${SIZE_BYTES}\r\n` +
      `Content-Length: ${SIZE_BYTES}\r\n\r\n`;
    const pieces = 8;
    for (let i = 0; i < pieces; i += 1) {
      socket.write(head.slice((i * head.length) / pieces, ((i + 1) * head.length) / pieces));
      await sleep(50);
    }
    // The body keeps making progress until the upload owner's aggregate ends it.
    const chunk = Buffer.alloc(1024, 0x61);
    while (!received && !socket.destroyed) {
      socket.write(chunk);
      await sleep(50);
    }
    await closed;
    assert.match(received, /^HTTP\/1\.1 500 /, 'the upload owner answers, not a Node 408');
    assert.match(received, /"reason":"transfer_ingress_deadline_exceeded"/);
  } finally {
    socket.destroy();
    await closeLoopbackServer(server);
  }
});
