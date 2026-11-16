import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { expect, onTestFinished, test, vi } from 'vitest';
import { createDaemonProxyServer } from '@agent-device/proxy';
import {
  closeLoopbackServer,
  createTestRuntimeStateHandle,
  listenOnLoopback,
} from '@agent-device/test-kit';
import {
  cleanupUploadedArtifact,
  prepareUploadedArtifact,
} from '../../resources/artifact-tracking.ts';
import { createDaemonHttpServer } from './http-server.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test.each(['disconnect and resume', 'uninterrupted'] as const)(
  'an actual proxy-to-daemon upload handles %s and verifies finalized bytes',
  async (mode) => {
    const runtime = createTestRuntimeStateHandle();
    try {
      await runtime.run(async () => {
        const daemon = await createDaemonHttpServer({
          token: 'daemon-secret',
          handleRequest: async () => ({ ok: true, data: {} }),
          env: process.env,
          cwd: process.cwd(),
        });
        const daemonPort = await listenOnLoopback(daemon);
        const proxy = createDaemonProxyServer({
          upstreamBaseUrl: `http://127.0.0.1:${daemonPort}`,
          upstreamToken: 'daemon-secret',
          clientToken: 'client-secret',
        });
        let tracked = '';
        try {
          const origin = `http://127.0.0.1:${await listenOnLoopback(proxy)}`;
          const content = Buffer.from('ABCDEF');
          const headers = {
            authorization: 'Bearer client-secret',
            'content-type': 'application/json',
          };
          const preflight = await fetch(`${origin}/upload/preflight`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              uploadAttemptId: crypto.randomUUID(),
              sha256: crypto.createHash('sha256').update(content).digest('hex'),
              fileName: 'demo.apk',
              sizeBytes: content.length,
              artifactType: 'file',
              platform: 'android',
            }),
          });
          expect(preflight.status).toBe(200);
          const ticket = (await preflight.json()) as {
            uploadId: string;
            upload: { url: string; headers: Record<string, string> };
          };
          expect(new URL(ticket.upload.url).origin).toBe(origin);
          expect(ticket.upload.headers.authorization).toBe('Bearer client-secret');
          const put = (range: string, body: string) =>
            fetch(ticket.upload.url, {
              method: 'PUT',
              headers: { ...ticket.upload.headers, 'content-range': range },
              body,
            });
          const first = await put('bytes 0-1/6', 'AB');
          expect(first.status).toBe(308);
          expect(first.headers.get('x-upload-offset')).toBe('2');
          await first.text();
          if (mode === 'disconnect and resume') {
            const prefix = deferred<string>();
            const rolledBack = deferred<void>();
            let payload = '';
            let watcher: fs.FSWatcher | undefined;
            const createWriter = fs.createWriteStream;
            const writerSpy = vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
              const writer = Reflect.apply(createWriter, fs, args) as fs.WriteStream;
              payload = String(args[0]);
              writer.once('open', () => {
                watcher = fs.watch(payload, () => {
                  void fs.promises.readFile(payload, 'utf8').then((bytes) => {
                    if (bytes === 'ABCD') prefix.resolve(bytes);
                  }, prefix.reject);
                });
              });
              return writer;
            });
            const truncate = fs.promises.truncate;
            const rollbackSpy = vi
              .spyOn(fs.promises, 'truncate')
              .mockImplementation(async (path, length) => {
                await truncate(path, length);
                if (String(path) === payload && length === 2) rolledBack.resolve();
              });
            onTestFinished(() => {
              watcher?.close();
              writerSpy.mockRestore();
              rollbackSpy.mockRestore();
            });
            const client = http.request(ticket.upload.url, {
              method: 'PUT',
              headers: { ...ticket.upload.headers, 'content-range': 'bytes 2-5/6' },
            });
            const errors: Error[] = [];
            client.on('error', (error) => errors.push(error));
            onTestFinished(() => {
              client.destroy();
            });
            client.write('CD');
            expect(await prefix.promise).toBe('ABCD');
            assert.equal(fs.readFileSync(payload, 'utf8'), 'ABCD');
            const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
            client.destroy();
            await closed;
            await rolledBack.promise;
            expect(fs.readFileSync(payload, 'utf8')).toBe('AB');
            expect(client.writableEnded).toBe(false);
            expect(
              errors.every((error) => (error as NodeJS.ErrnoException).code === 'ECONNRESET'),
            ).toBe(true);
            watcher?.close();
            writerSpy.mockRestore();
            rollbackSpy.mockRestore();
            const probe = await put('bytes 0-1/6', 'AB');
            expect(probe.status).toBe(308);
            expect(probe.headers.get('x-upload-offset')).toBe('2');
            await probe.text();
          }
          const complete = await put('bytes 2-5/6', 'CDEF');
          expect(complete.status).toBe(200);
          await complete.text();
          const finalize = await fetch(`${origin}/upload/finalize`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ uploadId: ticket.uploadId }),
          });
          expect(finalize.status).toBe(200);
          tracked = ((await finalize.json()) as { uploadId: string }).uploadId;
          expect(fs.readFileSync(prepareUploadedArtifact(tracked))).toEqual(content);
        } finally {
          if (tracked) cleanupUploadedArtifact(tracked);
          await closeLoopbackServer(proxy);
          await closeLoopbackServer(daemon);
        }
      });
    } finally {
      runtime.dispose();
    }
  },
);
