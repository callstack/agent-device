// #4518: a remote `record stop` writes only to a destination named by the current request, or to
// the cwd basename fallback with a typed warning. A daemon `localPath` is never authority. These
// tests drive the real materialize seam against a loopback server with owned temporary files.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { expect, test } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { materializeRemoteArtifacts } from '../daemon-artifacts.ts';

type World = { root: string; cwd: string; baseUrl: string };

function stopRequest(world: World, meta: DaemonWireRequest['meta'] = {}): DaemonWireRequest {
  return {
    token: 'secret',
    command: 'record',
    session: 'capture',
    positionals: ['stop'],
    meta: { cwd: world.cwd, ...meta },
  };
}

function artifact(partial: Partial<DaemonArtifact> & { field: string }): DaemonArtifact {
  return { artifactId: 'a1', path: '/daemon/x', fileName: 'x.mp4', ...partial } as DaemonArtifact;
}

async function materialize(
  world: World,
  artifacts: DaemonArtifact[],
  options: { meta?: DaemonWireRequest['meta']; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  const response: DaemonResponse = await materializeRemoteArtifacts(
    { baseUrl: world.baseUrl, token: 'secret' },
    stopRequest(world, options.meta),
    { ok: true, data: { artifacts } },
    createTestHostEnvironment(),
    path.join(world.root, 'state'),
    options.signal,
  );
  return response.ok ? (response.data ?? {}) : {};
}

async function withServer(
  t: Parameters<typeof skipWhenLoopbackUnavailable>[0],
  handler: http.RequestListener,
  run: (world: World) => Promise<void>,
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t, 'record download')) return;
  const server = http.createServer(handler);
  try {
    const port = await listenOnLoopback(server);
    const root = fs.realpathSync(mkdtempForTestSync('agent-device-record-download-'));
    const cwd = path.join(root, 'cwd');
    fs.mkdirSync(cwd);
    await run({ root, cwd, baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await closeLoopbackServer(server);
  }
}

const serveVideo: http.RequestListener = (_req, res) => res.end('video-bytes');

/** Serves the first chunk, then waits for `release` before finishing the body. */
function stalledServer() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const handler: http.RequestListener = (_req, res) => {
    res.write('video-');
    started();
    void released.then(() => res.end('bytes'));
  };
  return { handler, begun, release };
}

function stagingEntries(dir: string): string[] {
  return fs.readdirSync(dir).filter((entry) => entry.startsWith('.agent-device-download-'));
}

test('a stop never writes to a daemon localPath and warns about the cwd fallback', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const echoed = path.join(world.root, 'clips', 'demo.mp4');
    const data = await materialize(world, [artifact({ field: 'outPath', localPath: echoed })]);
    const fallback = path.join(world.cwd, 'x.mp4');
    expect(data.outPath).toBe(fallback);
    expect(fs.readFileSync(fallback, 'utf8')).toBe('video-bytes');
    expect(fs.existsSync(echoed)).toBe(false);
    expect(data.recordingDestinationWarnings).toEqual([
      { reason: 'recording_destination_not_requested', field: 'outPath', path: fallback },
    ]);
    expect(data.warnings).toEqual([expect.stringContaining(fallback)]);
  });
});

test('a stop writes to the destination its own request names, without a warning', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const requested = path.join(world.root, 'out', 'demo.mp4');
    const data = await materialize(world, [artifact({ field: 'outPath', localPath: '/x.mp4' })], {
      meta: { clientArtifactPaths: { outPath: requested } },
    });
    expect(data.outPath).toBe(requested);
    expect(fs.readFileSync(requested, 'utf8')).toBe('video-bytes');
    expect(data.recordingDestinationWarnings).toBeUndefined();
  });
});

test('a link at the fallback name is replaced and its target is untouched', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const target = path.join(world.root, 'victim.txt');
    fs.writeFileSync(target, 'original');
    const linked = path.join(world.cwd, 'x.mp4');
    fs.symlinkSync(target, linked);
    await materialize(world, [artifact({ field: 'outPath' })]);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    expect(fs.lstatSync(linked).isFile()).toBe(true);
    expect(fs.readFileSync(linked, 'utf8')).toBe('video-bytes');
    expect(stagingEntries(world.cwd)).toEqual([]);
  });
});

test('a recording reply that claims the directory type downloads one file', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const data = await materialize(world, [
      artifact({ field: 'outPath', artifactType: 'test-artifacts' }),
    ]);
    expect(fs.readFileSync(String(data.outPath), 'utf8')).toBe('video-bytes');
  });
});

// a. A caller abort during the transfer stops the download and its publish, then cleans up.
test('a caller abort during the transfer publishes nothing and leaves no staging', async (t) => {
  const stalled = stalledServer();
  await withServer(t, stalled.handler, async (world) => {
    const controller = new AbortController();
    const pending = materialize(world, [artifact({ field: 'outPath' })], {
      signal: controller.signal,
    });
    await stalled.begun;
    controller.abort();
    stalled.release();
    await expect(pending).rejects.toMatchObject({ details: { reason: 'request_canceled' } });
    expect(fs.readdirSync(world.cwd)).toEqual([]);
  });
});

// b. A later failure still reports the files already written to cwd.
test('a failed later artifact reports the earlier cwd fallback in the error', async (t) => {
  await withServer(
    t,
    (req, res) => {
      if (req.url?.includes('telemetry')) res.writeHead(500);
      res.end('video-bytes');
    },
    async (world) => {
      const failure = await materialize(world, [
        artifact({ field: 'outPath' }),
        artifact({ artifactId: 'telemetry', field: 'telemetryPath', fileName: 't.json' }),
      ]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).details?.recordingDestinationWarnings).toEqual([
        {
          reason: 'recording_destination_not_requested',
          field: 'outPath',
          path: path.join(world.cwd, 'x.mp4'),
        },
      ]);
    },
  );
});

// c. A parent swapped during the transfer is refused, and nothing touches the new directory.
test('a parent swapped during the transfer is refused without touching the new directory', async (t) => {
  const stalled = stalledServer();
  await withServer(t, stalled.handler, async (world) => {
    const pending = materialize(world, [artifact({ field: 'outPath' })]).catch(
      (error: unknown) => error,
    );
    await stalled.begun;
    const moved = path.join(world.root, 'moved-cwd');
    fs.renameSync(world.cwd, moved);
    fs.mkdirSync(world.cwd);
    stalled.release();
    const failure = (await pending) as AppError;
    expect(failure.details?.reason).toBe('artifact_destination_replaced');
    expect(fs.readdirSync(world.cwd)).toEqual([]);
    const staging = String(failure.details?.stagingPath);
    expect(path.dirname(staging)).toBe(world.cwd);
    expect(fs.existsSync(path.join(moved, path.basename(staging)))).toBe(true);
  });
});

// 1. A peer file name is ONE ordinary local file name, so it cannot switch drives or leave cwd.
test.for(['C:foo.mp4', 'CON.mp4', 'clip.mp4:stream', 'nul', '..', 'clip.mp4.'])(
  'a fallback name %s is replaced by a generated name inside cwd',
  async (fileName, t) => {
    await withServer(t, serveVideo, async (world) => {
      const data = await materialize(world, [artifact({ field: 'outPath', fileName })]);
      const written = String(data.outPath);
      const name = path.basename(written);
      expect(path.dirname(written)).toBe(world.cwd);
      expect(name).toMatch(/^outPath-\d+$/);
      // The chosen name stays one component under Windows rules too.
      expect(path.win32.basename(name)).toBe(name);
      expect(path.win32.resolve('D:\\work', name)).toBe(`D:\\work\\${name}`);
    });
  },
);

// 2. Chunk paths name the files this client published, not the daemon's paths.
test('a multi-chunk recording reports the chunk paths this client published', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const response = await materializeRemoteArtifacts(
      { baseUrl: world.baseUrl, token: 'secret' },
      stopRequest(world),
      {
        ok: true,
        data: {
          chunks: [
            { index: 0, path: '/daemon/demo.mp4' },
            { index: 1, path: '/daemon/demo.part-001.mp4' },
          ],
          artifacts: [
            artifact({ field: 'outPath', fileName: 'demo.mp4' }),
            artifact({ artifactId: 'c1', field: 'chunkPath', fileName: 'demo.part-001.mp4' }),
          ],
        },
      },
      createTestHostEnvironment(),
      path.join(world.root, 'state'),
    );
    expect(response.ok && response.data?.chunks).toEqual([
      { index: 0, path: path.join(world.cwd, 'demo.mp4') },
      { index: 1, path: path.join(world.cwd, 'demo.part-001.mp4') },
    ]);
  });
});

// 4. The fallback text also reaches details.warnings, which the human error renderer prints.
test('a failed later artifact adds the fallback text to details.warnings', async (t) => {
  await withServer(
    t,
    (req, res) => {
      if (req.url?.includes('telemetry')) res.writeHead(500);
      res.end('video-bytes');
    },
    async (world) => {
      const failure = (await materialize(world, [
        artifact({ field: 'outPath' }),
        artifact({ artifactId: 'telemetry', field: 'telemetryPath', fileName: 't.json' }),
      ]).catch((error: unknown) => error)) as AppError;
      expect(failure.details?.warnings).toEqual([
        expect.stringContaining(path.join(world.cwd, 'x.mp4')),
      ]);
    },
  );
});

test('a recording that cannot be staged fails with a typed artifact reason', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const notADirectory = path.join(world.root, 'file');
    fs.writeFileSync(notADirectory, '');
    await expect(
      materialize(world, [artifact({ field: 'outPath' })], { meta: { cwd: notADirectory } }),
    ).rejects.toMatchObject({ details: { reason: 'artifact_publish_failed' } });
  });
});
