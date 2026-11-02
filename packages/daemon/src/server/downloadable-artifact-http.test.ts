import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import { runCmdSync } from '@agent-device/host-kit/command';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { trackDownloadableArtifact } from '../resources/artifact-tracking.ts';
import { createDaemonHttpServer } from './http/http-server.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each(['another download completes', 'expiry fires'] as const)(
  'a directory download keeps its archive until its delayed file open finishes when %s',
  async (trigger) => {
    const root = mkdtempForTestSync('fu-art-download-');
    const source = path.join(root, 'profile.trace');
    fs.mkdirSync(source);
    const expected = crypto.randomBytes(64 * 1024).toString('hex');
    fs.writeFileSync(path.join(source, 'payload'), expected);
    const runtime = createRuntimeStateHandle();
    const server = await runtime.run(() =>
      createDaemonHttpServer({
        token: 'fu-art-secret',
        handleRequest: async () => ({ ok: true, data: {} }),
        env: process.env,
        cwd: process.cwd(),
      }),
    );
    const port = await listenOnLoopback(server);
    const headers = { authorization: 'Bearer fu-art-secret' };
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const artifactId = runtime.run(() =>
      trackDownloadableArtifact({
        artifactPath: source,
        artifactType: 'trace-log',
      }),
    );
    const expire = timer.mock.calls[0]![0];
    timer.mockRestore();
    const url = `http://127.0.0.1:${port}/artifacts/${artifactId}`;
    const opened = deferred();
    const release = deferred();
    const createReadStream = fs.createReadStream;
    const cleanup = vi.spyOn(fs, 'rmSync');
    let archivePath = '';
    const streams: fs.ReadStream[] = [];
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
      archivePath = String(file);
      const stream = createReadStream(file, {
        ...(typeof options === 'object' ? options : {}),
        fs: {
          ...fs,
          open: (filePath, flags, mode, callback) => {
            opened.resolve();
            void release.promise.then(() => fs.open(filePath, flags, mode, callback));
          },
        },
      });
      streams.push(stream);
      return stream;
    });
    const download = () =>
      fetch(url, { headers }).then(async (response) => {
        if (response.status !== 200) {
          await response.body?.cancel();
          return { status: response.status, bytes: Buffer.alloc(0) };
        }
        return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
      });
    const pending = download();
    try {
      await opened.promise;
      spy.mockRestore();
      let first: Awaited<ReturnType<typeof download>> | undefined;
      if (trigger === 'another download completes') {
        first = await download();
        expect(first.status).toBe(200);
      } else {
        runtime.run(expire);
      }
      const archiveDir = path.dirname(archivePath);
      expect(fs.existsSync(archivePath)).toBe(true);
      expect(fs.existsSync(source)).toBe(true);
      expect((await fetch(url, { headers })).status).toBe(404);
      const inventory = await fetch(`http://127.0.0.1:${port}/artifacts`, { headers });
      expect(await inventory.json()).toEqual({ artifacts: [] });
      release.resolve();
      const delayed = await pending;
      expect(delayed.status).toBe(200);
      if (first) expect(delayed.bytes).toEqual(first.bytes);
      const downloaded = path.join(root, 'download.tar.gz');
      fs.writeFileSync(downloaded, delayed.bytes);
      expect(runCmdSync('tar', ['-xOzf', downloaded, 'profile.trace/payload']).stdout).toBe(
        expected,
      );
      await vi.waitFor(() => expect(fs.existsSync(archiveDir)).toBe(false));
      expect(fs.existsSync(source)).toBe(false);
      for (const target of [source, archiveDir]) {
        expect(cleanup.mock.calls.filter(([removed]) => removed === target)).toHaveLength(1);
      }
    } finally {
      release.resolve();
      spy.mockRestore();
      cleanup.mockRestore();
      for (const stream of streams) stream.destroy();
      await Promise.allSettled([pending]);
      await closeLoopbackServer(server);
      runtime.dispose();
    }
  },
);
