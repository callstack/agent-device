// #4518: a remote `record stop` writes only to a destination named by the current request, or to
// the cwd basename fallback with a typed warning. A daemon `localPath` is never authority. These
// tests drive the real materialize seam against a loopback server with owned temporary files.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { expect, test, vi } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { materializeRemoteArtifacts } from '../daemon-artifacts.ts';
import { sendRemoteScriptOpen } from '../session-script-destination.ts';

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
  const role =
    partial.field === 'outPath'
      ? 'recording'
      : partial.field === 'telemetryPath'
        ? 'telemetry'
        : 'chunk';
  const artifactType = role === 'recording' ? 'screen-recording' : `screen-recording-${role}`;
  return { artifactId: 'a1', path: '/daemon/x', fileName: 'x.mp4', role, artifactType, ...partial };
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
    const requested = path.join(world.root, 'demo.mp4');
    fs.writeFileSync(requested, 'previous video');
    const data = await materialize(world, [artifact({ field: 'outPath', localPath: '/x.mp4' })], {
      meta: { clientArtifactPaths: { outPath: requested } },
    });
    expect(data.outPath).toBe(requested);
    expect(fs.readFileSync(requested, 'utf8')).toBe('video-bytes');
    expect(data.recordingDestinationWarnings).toBeUndefined();
  });
});

test.for(['link', 'file', 'case variant'] as const)(
  'an occupied cwd fallback preserves the existing %s',
  async (taken, t) => {
    await withServer(t, serveVideo, async (world) => {
      const target = path.join(world.root, 'target.txt');
      fs.writeFileSync(target, 'original');
      const existing = path.join(world.cwd, taken === 'case variant' ? 'X.mp4' : 'x.mp4');
      if (taken === 'link') fs.symlinkSync(target, existing);
      else fs.writeFileSync(existing, 'earlier');

      const candidate = path.join(world.cwd, 'x.mp4');
      const pending = materialize(world, [artifact({ field: 'outPath' })]);
      if (fs.existsSync(candidate)) {
        await expect(pending).rejects.toMatchObject({
          details: { reason: 'artifact_publish_failed', destinationPath: candidate },
        });
      } else {
        await expect(pending).resolves.toMatchObject({ outPath: candidate });
      }
      expect(fs.readFileSync(target, 'utf8')).toBe('original');
      if (taken === 'link') expect(fs.lstatSync(existing).isSymbolicLink()).toBe(true);
      else expect(fs.readFileSync(existing, 'utf8')).toBe('earlier');
      expect(stagingEntries(world.cwd)).toEqual([]);
    });
  },
);

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
    expect(failure.details?.stagingPath).toBeUndefined();
    expect(stagingEntries(moved)).toHaveLength(1);
  });
});

// 1. A peer file name is ONE ordinary local file name, so it cannot switch drives or leave cwd.
test.for([
  'C:foo.mp4',
  'CON.mp4',
  'CONIN$.mp4',
  'NUL .mp4',
  'clip.mp4:stream',
  'nul',
  '..',
  'clip.mp4.',
  'clip\uD800.mp4',
  `${'a'.repeat(252)}.mp4`,
])('a fallback name %s is replaced by a generated name inside cwd', async (fileName, t) => {
  await withServer(t, serveVideo, async (world) => {
    const data = await materialize(world, [artifact({ field: 'outPath', fileName })]);
    const written = String(data.outPath);
    const name = path.basename(written);
    expect(path.dirname(written)).toBe(world.cwd);
    expect(name).toMatch(/^outPath-\d+$/);
    // The chosen name stays one component under Windows rules too.
    expect(path.win32.basename(name)).toBe(name);
    expect(path.win32.resolve(String.raw`D:\work`, name)).toBe(
      String.raw`D:\work` + path.win32.sep + name,
    );
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

// 3c. A parent that becomes unreadable or a non-directory mid-transfer is a typed refusal.
test.for(['EACCES', 'ENOTDIR'] as const)(
  'a parent that turns %s during the transfer is refused with a typed reason',
  async (fault, t) => {
    if (fault === 'EACCES' && process.getuid?.() === 0) return;
    const stalled = stalledServer();
    await withServer(t, stalled.handler, async (world) => {
      const pending = materialize(world, [artifact({ field: 'outPath' })]).catch(
        (error: unknown) => error,
      );
      await stalled.begun;
      const moved = `${world.root}-moved`;
      if (fault === 'EACCES') fs.chmodSync(world.root, 0o000);
      else {
        fs.renameSync(world.root, moved);
        fs.writeFileSync(world.root, '');
      }
      try {
        stalled.release();
        const failure = (await pending) as AppError;
        expect(failure).toBeInstanceOf(AppError);
        expect(failure.details?.reason).toBe('artifact_destination_replaced');
      } finally {
        if (fault === 'EACCES') fs.chmodSync(world.root, 0o700);
        else {
          fs.rmSync(world.root, { force: true });
          fs.renameSync(moved, world.root);
        }
      }
    });
  },
);

// #4518: a remote record stop reports a local output path only for a file this client wrote.
test.for([
  {
    name: 'an outPath artifact without an id',
    artifacts: [{ field: 'outPath', path: '/daemon/clip.mp4', fileName: 'clip.mp4' }],
  },
  { name: 'an outPath with no artifacts at all', artifacts: [] },
])('a stop with $name reports no outPath', async ({ artifacts }, t) => {
  await withServer(t, serveVideo, async (world) => {
    const response = await materializeRemoteArtifacts(
      { baseUrl: world.baseUrl, token: 'secret' },
      stopRequest(world),
      {
        ok: true,
        data: {
          outPath: '/daemon/clip.mp4',
          telemetryPath: '/daemon/clip.gesture-telemetry.json',
          chunks: [{ index: 0, path: '/daemon/clip.mp4' }],
          artifacts: artifacts as DaemonArtifact[],
        },
      },
      createTestHostEnvironment(),
      path.join(world.root, 'state'),
    );
    const data = response.ok ? (response.data ?? {}) : {};
    expect(data.outPath).toBeUndefined();
    expect(data.telemetryPath).toBeUndefined();
    expect(data.chunks).toBeUndefined();
    expect(fs.readdirSync(world.cwd)).toEqual([]);
  });
});

test('a stop that downloads its recording reports the path this client wrote', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const data = await materialize(world, [
      artifact({ field: 'outPath', path: '/daemon/clip.mp4', fileName: 'clip.mp4' }),
    ]);
    expect(data.outPath).toBe(path.join(world.cwd, 'clip.mp4'));
    expect(fs.readFileSync(path.join(world.cwd, 'clip.mp4'), 'utf8')).toBe('video-bytes');
  });
});

/** Runs one remote record stop answer through the materializer and returns the caller's data. */
async function stopAnswer(world: World, data: Record<string, unknown>, signal?: AbortSignal) {
  const response = await materializeRemoteArtifacts(
    { baseUrl: world.baseUrl, token: 'secret' },
    stopRequest(world),
    { ok: true, data },
    createTestHostEnvironment(),
    path.join(world.root, 'state'),
    signal,
  );
  return response.ok ? (response.data ?? {}) : {};
}

// #4518 hostile answers: only named recording facts and this client's own files survive.
test('a remote record stop drops a peer sessionStateDir and unknown fields', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const data = await stopAnswer(world, {
      recording: 'stopped',
      durationMs: 5,
      capturedDurationMs: Infinity,
      sessionStateDir: '/daemon/state',
      unknownField: { localPath: '/client/x' },
      artifacts: [],
    });
    expect(data).toEqual({ recording: 'stopped', durationMs: 5, artifacts: [] });
  });
});

test('a remote record stop keeps peer warning text only as daemonWarnings', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const data = await stopAnswer(world, {
      warning: 'w1',
      overlayWarning: 'w2',
      warnings: ['w3'],
      scriptDeliveryFailure: { reason: 'script_delivery_failed' },
      artifacts: [],
    });
    expect(data.daemonWarnings).toEqual(['w1', 'w2', 'w3']);
    for (const field of ['warning', 'overlayWarning', 'warnings', 'scriptDeliveryFailure']) {
      expect(data[field], field).toBeUndefined();
    }
  });
});

test.for([
  {
    name: 'a repeated artifact id',
    artifacts: [
      { artifactId: 'a', field: 'outPath', path: '/daemon/a.mp4' },
      { artifactId: 'a', field: 'telemetryPath', path: '/daemon/a.json' },
    ],
  },
  {
    name: 'a session script sharing an id with the recording',
    artifacts: [
      { artifactId: 'a', field: 'savedScript', artifactType: 'session-script', scriptRevision: 1 },
      { artifactId: 'a', field: 'outPath', path: '/daemon/a.mp4' },
    ],
  },
  {
    name: 'two roles with the same fallback name in another case',
    artifacts: [
      { artifactId: 'a', field: 'outPath', fileName: 'clip.mp4' },
      { artifactId: 'b', field: 'telemetryPath', fileName: 'CLIP.mp4' },
    ],
  },
])('a record stop answer with $name is refused before any download', async ({ artifacts }, t) => {
  let hits = 0;
  await withServer(
    t,
    (_req, res) => {
      hits += 1;
      res.end('video-bytes');
    },
    async (world) => {
      const scriptPath = path.join(world.root, 'capture.ad');
      const script = artifacts.find((entry) => entry.field === 'savedScript');
      const scriptPublicationId = script && (await armScript(world, scriptPath));
      await expect(
        stopAnswer(world, {
          artifacts: artifacts.map((entry) =>
            entry === script ? { ...entry, scriptPublicationId } : artifact(entry),
          ),
        }),
      ).rejects.toMatchObject({ details: { reason: 'record_stop_answer_invalid' } });
      expect(hits).toBe(0);
      expect(fs.existsSync(scriptPath)).toBe(false);
      expect(fs.readdirSync(world.cwd)).toEqual([]);
    },
  );
});

async function armScript(world: World, scriptPath: string): Promise<string | undefined> {
  let scriptPublicationId: string | undefined;
  await sendRemoteScriptOpen(
    { baseUrl: world.baseUrl, token: 'secret', capabilities: ['script-artifacts'] },
    {
      ...stopRequest(world, { clientArtifactPaths: { savedScript: scriptPath } }),
      command: 'open',
      positionals: ['Demo'],
    },
    path.join(world.root, 'state'),
    async (req) => {
      scriptPublicationId = req.meta?.scriptPublicationId;
      return { ok: true, data: { scriptPublicationId } };
    },
  );
  expect(scriptPublicationId).toBeDefined();
  return scriptPublicationId;
}

test('a recording fallback cannot claim a script destination in the same answer', async (t) => {
  const requestedArtifacts: string[] = [];
  await withServer(
    t,
    (req, res) => {
      requestedArtifacts.push(req.url ?? '');
      res.end(req.url === '/artifacts/script' ? 'open Demo\n' : 'video');
    },
    async (world) => {
      const scriptPath = path.join(world.cwd, 'capture.ad');
      const scriptPublicationId = await armScript(world, scriptPath);
      await expect(
        stopAnswer(world, {
          artifacts: [
            artifact({ field: 'outPath', fileName: 'capture.ad' }),
            {
              artifactId: 'script',
              field: 'savedScript',
              artifactType: 'session-script',
              scriptRevision: 1,
              scriptPublicationId,
            },
          ],
        }),
      ).rejects.toMatchObject({ details: { reason: 'record_stop_answer_invalid' } });
      expect(requestedArtifacts).toEqual([]);
      expect(fs.existsSync(scriptPath)).toBe(false);
    },
  );
});

test('an abort while a staged delivery fails during preparation is request_canceled', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const controller = new AbortController();
    const mkdir = vi.spyOn(fs.promises, 'mkdir').mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error(), { code: 'ENOTDIR' });
    });
    try {
      await expect(
        materialize(world, [artifact({ field: 'outPath' })], { signal: controller.signal }),
      ).rejects.toMatchObject({ details: { reason: 'request_canceled' } });
    } finally {
      mkdir.mockRestore();
    }
  });
});
