import { connect } from 'node:net';
import fs from 'node:fs';
import https from 'node:https';
import { expect, test } from 'vitest';
import {
  closeLoopbackServer,
  createTestRuntimeStateHandle,
  listenOnLoopback,
} from '@agent-device/test-kit';
import { createDaemonHttpServer } from './http-server.ts';
import { startRpcServer } from '../__tests__/http-server-rpc.fixtures.ts';

const body = JSON.stringify({
  sha256: 'a'.repeat(64),
  uploadAttemptId: 'origin-test',
  fileName: 'artifact.txt',
  sizeBytes: 1,
  artifactType: 'file',
});

test.each([undefined, 'https://public.example:8443/'])(
  'daemon preflight selects socket or configured origin %s',
  async (publicOrigin) => {
    const runtime = createTestRuntimeStateHandle();
    try {
      await runtime.run(async () => {
        const { server, port } = await startRpcServer('secret', async () => ({ ok: true }), {
          publicOrigin,
        });
        try {
          const response = await fetch(`http://127.0.0.1:${port}/upload/preflight?source=client`, {
            method: 'POST',
            headers: {
              authorization: 'Bearer secret',
              'x-forwarded-proto': 'https, http',
              'x-forwarded-host': 'evil.example',
              forwarded: 'host=evil.example;proto=https',
            },
            body,
          });
          expect(response.status).toBe(200);
          const payload = (await response.json()) as { upload: { url: string } };
          expect(new URL(payload.upload.url).origin).toBe(
            publicOrigin ? 'https://public.example:8443' : `http://127.0.0.1:${port}`,
          );
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      });
    } finally {
      runtime.dispose();
    }
  },
);

test('daemon refuses invalid public origin before creating a listener', async () => {
  await expect(
    createDaemonHttpServer({
      env: {},
      cwd: process.cwd(),
      handleRequest: async () => ({ ok: true }),
      publicOrigin: 'https://example.com/path',
    }),
  ).rejects.toThrow();
});

test('daemon preflight uses the real TLS socket despite forged HTTP metadata', async () => {
  const runtime = createTestRuntimeStateHandle();
  try {
    await runtime.run(async () => {
      const cert = fs.readFileSync(
        new URL(
          '../../../../../test/integration/provider-scenarios/fixtures/localhost-cert.pem',
          import.meta.url,
        ),
      );
      const key = fs.readFileSync(
        new URL(
          '../../../../../test/integration/provider-scenarios/fixtures/localhost-key.pem',
          import.meta.url,
        ),
      );
      const daemon = await createDaemonHttpServer({
        token: 'secret',
        handleRequest: async () => ({ ok: true }),
        env: {},
        cwd: process.cwd(),
      });
      const server = https.createServer({ cert, key }, (request, response) => {
        daemon.emit('request', request, response);
      });
      try {
        const port = await listenOnLoopback(server);
        const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const request = https.request(
            `https://127.0.0.1:${port}/upload/preflight`,
            {
              method: 'POST',
              ca: cert,
              headers: { authorization: 'Bearer secret', 'x-forwarded-proto': 'http' },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => chunks.push(chunk));
              response.on('error', reject);
              response.on('end', () =>
                resolve({
                  status: response.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf8'),
                }),
              );
            },
          );
          request.on('error', reject);
          request.end(body);
        });
        expect(result.status).toBe(200);
        const ticket = JSON.parse(result.body) as { upload: { url: string } };
        expect(new URL(ticket.upload.url).origin).toBe(`https://127.0.0.1:${port}`);
      } finally {
        await closeLoopbackServer(server);
        await closeLoopbackServer(daemon);
      }
    });
  } finally {
    runtime.dispose();
  }
});

test('daemon rejects invalid upload ingress and unauthenticated Host-less health probes', async () => {
  const { server, port } = await startRpcServer('secret', async () => ({ ok: true }), {
    publicOrigin: 'https://public.example',
  });
  try {
    for (const [target, hosts, method] of [
      ['/upload/preflight', '', 'POST'],
      ['/upload/preflight', 'Host: a\r\nHost: b\r\n', 'POST'],
      ['/upload/preflight', 'Host: user@host\r\n', 'POST'],
      ['http://evil/upload/preflight', 'Host: good\r\n', 'POST'],
      ['//evil/upload/preflight', 'Host: good\r\n', 'POST'],
      ['/health', '', 'GET'],
    ]) {
      const authorization = target === '/health' ? '' : 'Authorization: Bearer secret\r\n';
      const request = `${method} ${target} HTTP/1.0\r\n${hosts}${authorization}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => socket.write(request));
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk;
        });
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });
      expect(response).toMatch(/^HTTP\/1\.1 400/);
      expect(response).not.toContain('uploadId');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
