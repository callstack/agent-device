import { connect } from 'node:net';
import { expect, test } from 'vitest';
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

test('daemon rejects invalid ingress before preflight allocation even with fixed origin', async () => {
  const { server, port } = await startRpcServer('secret', async () => ({ ok: true }), {
    publicOrigin: 'https://public.example',
  });
  try {
    for (const [target, hosts] of [
      ['/upload/preflight', ''],
      ['/upload/preflight', 'Host: a\r\nHost: b\r\n'],
      ['/upload/preflight', 'Host: user@host\r\n'],
      ['http://evil/upload/preflight', 'Host: good\r\n'],
      ['//evil/upload/preflight', 'Host: good\r\n'],
    ]) {
      const request = `POST ${target} HTTP/1.1\r\n${hosts}Authorization: Bearer secret\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
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
