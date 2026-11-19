// #4518: a remote recording grant is a destination this client saved at `record start` under a
// client-generated ID. Requests bind to the store before dispatch and settle from the daemon's
// answer. A `record stop` writes a daemon `localPath` only when it derives from a bound grant. The
// daemon response is untrusted. These tests drive the real bind/materialize seams against a
// loopback server with owned temporary files only.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import { expect, test } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import {
  bindCaptureRequest,
  materializeRemoteArtifacts,
  type CaptureBinding,
} from '../daemon-artifacts.ts';

type World = { root: string; stateDir: string; cwd: string; baseUrl: string };
type Ok = Extract<DaemonResponse, { ok: true }>;

function makeWorld(prefix: string, port: number): World {
  const root = fs.realpathSync(mkdtempForTestSync(prefix));
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  return { root, stateDir: path.join(root, 'state'), cwd, baseUrl: `http://127.0.0.1:${port}` };
}

function request(
  world: World,
  command: string,
  positionals: string[] = [],
  meta: DaemonWireRequest['meta'] = {},
  session = 'capture',
): DaemonWireRequest {
  return { token: 'secret', command, session, positionals, meta: { cwd: world.cwd, ...meta } };
}

function startRequest(world: World, destination: string, session = 'capture') {
  return request(
    world,
    'record',
    ['start'],
    { clientArtifactPaths: { outPath: destination } },
    session,
  );
}

function artifact(partial: Partial<DaemonArtifact> & { field: string }): DaemonArtifact {
  return { artifactId: 'a1', path: '/daemon/x', fileName: 'x.mp4', ...partial } as DaemonArtifact;
}

async function bind(world: World, req: DaemonWireRequest): Promise<CaptureBinding> {
  const binding = await bindCaptureRequest(
    req,
    { baseUrl: world.baseUrl, token: 'secret' },
    world.stateDir,
  );
  if (!binding) throw new Error('expected a capture binding');
  return binding;
}

async function materialize(
  world: World,
  req: DaemonWireRequest,
  binding: CaptureBinding | undefined,
  response: Ok,
): Promise<DaemonResponse> {
  return await materializeRemoteArtifacts(
    { baseUrl: world.baseUrl, token: 'secret' },
    req,
    response,
    createTestHostEnvironment(),
    world.stateDir,
    binding,
  );
}

/** A start whose daemon answer is `answer`: confirmed, refused, or never seen. */
async function start(
  world: World,
  destination: string,
  answer: 'confirmed' | 'refused' | 'unknown' = 'confirmed',
  session = 'capture',
): Promise<void> {
  const req = startRequest(world, destination, session);
  const binding = await bind(world, req);
  if (answer === 'confirmed') await materialize(world, req, binding, { ok: true, data: {} });
  if (answer === 'refused') {
    await binding.settle({ ok: false, error: { code: 'COMMAND_FAILED', message: 'busy' } });
  }
}

/** Runs one stop whose reply names `localPath` for `outPath`, and returns the response data. */
async function stop(world: World, localPath: string | undefined, session = 'capture') {
  const req = request(world, 'record', ['stop'], {}, session);
  const binding = await bind(world, req);
  const response = await materialize(world, req, binding, {
    ok: true,
    data: { artifacts: [artifact({ field: 'outPath', localPath })] },
  });
  return response.ok ? (response.data ?? {}) : {};
}

function storeDir(world: World): string {
  return path.join(world.stateDir, 'remote-connections', 'capture-destinations');
}

function grantCount(world: World): number {
  const dir = storeDir(world);
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .reduce(
      (total, name) => total + JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).length,
      0,
    );
}

async function withServer(
  t: Parameters<typeof skipWhenLoopbackUnavailable>[0],
  handler: http.RequestListener,
  run: (world: World) => Promise<void>,
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t, 'capture destination')) return;
  const server = http.createServer(handler);
  try {
    await run(makeWorld('agent-device-capture-destination-', await listenOnLoopback(server)));
  } finally {
    await closeLoopbackServer(server);
  }
}

const serveVideo: http.RequestListener = (_req, res) => res.end('video-bytes');

test('a stop in another cwd writes the saved destination and its derivations, then retires it', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const granted = path.join(world.root, 'clips', 'demo');
    await start(world, granted);
    const otherCwd = path.join(world.root, 'other-cwd');
    fs.mkdirSync(otherCwd);
    const chunkPath = `${granted}.part-002.mp4`;
    const telemetryPath = `${granted}.gesture-telemetry.json`;
    const req = request(world, 'record', ['stop'], { cwd: otherCwd });
    const response = await materialize(world, req, await bind(world, req), {
      ok: true,
      data: {
        artifacts: [
          artifact({ field: 'outPath', localPath: `${granted}.mp4` }),
          artifact({ artifactId: 'c2', field: 'chunkPath', localPath: chunkPath }),
          artifact({ artifactId: 't', field: 'telemetryPath', localPath: telemetryPath }),
        ],
      },
    });
    expect(response.ok && response.data?.outPath).toBe(`${granted}.mp4`);
    expect(response.ok && response.data?.warnings).toBeUndefined();
    for (const file of [`${granted}.mp4`, chunkPath, telemetryPath]) {
      expect(fs.readFileSync(file, 'utf8')).toBe('video-bytes');
    }
    expect(fs.readdirSync(otherCwd)).toEqual([]);
    expect(grantCount(world)).toBe(0);
  });
});

test.for([
  { name: 'a path outside every saved derivation', localPath: 'hostile.mp4' },
  { name: 'a sibling that is not a chunk', localPath: 'demo.evil.mp4' },
  { name: "another session's saved destination", localPath: 'other.mp4' },
])('a stop refuses $name and warns about the cwd fallback', async (testCase, t) => {
  await withServer(t, serveVideo, async (world) => {
    const clips = path.join(world.root, 'clips');
    await start(world, path.join(clips, 'demo'));
    await start(world, path.join(clips, 'other.mp4'), 'confirmed', 'elsewhere');
    const hostile = path.join(clips, testCase.localPath);
    const data = await stop(world, hostile);
    const fallback = path.join(world.cwd, 'x.mp4');
    expect(data.outPath).toBe(fallback);
    expect(fs.readFileSync(fallback, 'utf8')).toBe('video-bytes');
    expect(fs.existsSync(hostile)).toBe(false);
    expect(data.recordingDestinationWarnings).toEqual([
      { reason: 'capture_destination_not_derived', field: 'outPath', path: fallback },
    ]);
  });
});

// 1. Write safety: a link at the saved or fallback name is replaced, never written through.
test.for(['saved', 'fallback'] as const)(
  'a link at the %s name is replaced and its target is untouched',
  async (name, t) => {
    await withServer(t, serveVideo, async (world) => {
      const granted = path.join(world.root, 'demo.mp4');
      await start(world, granted);
      const target = path.join(world.root, 'victim.txt');
      fs.writeFileSync(target, 'original');
      const linked = name === 'saved' ? granted : path.join(world.cwd, 'x.mp4');
      fs.symlinkSync(target, linked);
      const data = await stop(world, name === 'saved' ? granted : '/elsewhere/demo.mp4');
      expect(data.outPath).toBe(linked);
      expect(fs.readFileSync(target, 'utf8')).toBe('original');
      expect(fs.lstatSync(linked).isFile()).toBe(true);
      expect(fs.readFileSync(linked, 'utf8')).toBe('video-bytes');
      expect(
        fs
          .readdirSync(path.dirname(linked))
          .some((entry) => entry.startsWith('.agent-device-download-')),
      ).toBe(false);
    });
  },
);

// 2. A recording reply that claims a directory type still downloads one file.
test('a recording reply that claims the directory type downloads one file', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const granted = path.join(world.root, 'demo.mp4');
    await start(world, granted);
    const req = request(world, 'record', ['stop']);
    const response = await materialize(world, req, await bind(world, req), {
      ok: true,
      data: {
        artifacts: [
          artifact({ field: 'outPath', localPath: granted, artifactType: 'test-artifacts' }),
        ],
      },
    });
    expect(response.ok && response.data?.outPath).toBe(granted);
    expect(fs.readFileSync(granted, 'utf8')).toBe('video-bytes');
  });
});

// 3. Store trust: a store that is not a private directory, or a file with any invalid entry,
// is a typed failure, never an empty or partial grant set.
test.for(['shared-mode store', 'invalid entry'] as const)(
  'a %s degrades the start and the stop with typed warnings',
  async (fault, t) => {
    await withServer(t, serveVideo, async (world) => {
      const granted = path.join(world.root, 'demo.mp4');
      await start(world, granted);
      const [file] = fs.readdirSync(storeDir(world));
      const scopeFile = path.join(storeDir(world), file!);
      if (fault === 'shared-mode store') fs.chmodSync(storeDir(world), 0o755);
      else {
        const grants = JSON.parse(fs.readFileSync(scopeFile, 'utf8'));
        fs.writeFileSync(scopeFile, JSON.stringify([...grants, { id: 'x', destination: '/x' }]));
      }
      const before = fs.readFileSync(scopeFile, 'utf8');

      const startReq = startRequest(world, path.join(world.root, 'next.mp4'));
      const started = await materialize(world, startReq, await bind(world, startReq), {
        ok: true,
        data: {},
      });
      expect(started.ok && started.data?.recordingDestinationWarnings).toEqual([
        { reason: 'capture_destination_store_unavailable' },
      ]);
      expect(fs.readFileSync(scopeFile, 'utf8')).toBe(before);

      const data = await stop(world, granted);
      expect(data.outPath).toBe(path.join(world.cwd, 'x.mp4'));
      expect(data.recordingDestinationWarnings).toContainEqual({
        reason: 'capture_destination_store_unavailable',
        field: 'outPath',
        path: path.join(world.cwd, 'x.mp4'),
      });
    });
  },
);

// 4. A legacy reply without a localPath still warns about the cwd fallback.
test('a stop reply without a localPath warns with the fallback destination', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    await start(world, path.join(world.root, 'demo.mp4'));
    const data = await stop(world, undefined);
    const fallback = path.join(world.cwd, 'x.mp4');
    expect(data.recordingDestinationWarnings).toEqual([
      { reason: 'capture_destination_missing', field: 'outPath', path: fallback },
    ]);
    expect(data.warnings).toEqual([expect.stringContaining(fallback)]);
  });
});

// 5. Settlement follows the confirmed outcome, not path echoes or download success.
test('a confirmed stop retires its grants even when the download fails', async (t) => {
  await withServer(
    t,
    (_req, res) => {
      res.writeHead(500);
      res.end('down');
    },
    async (world) => {
      await start(world, path.join(world.root, 'demo.mp4'));
      await expect(stop(world, path.join(world.root, 'demo.mp4'))).rejects.toThrow();
      expect(grantCount(world)).toBe(0);
    },
  );
});

test.for([
  { code: 'SESSION_NOT_FOUND', retired: true },
  { code: 'COMMAND_FAILED', retired: false },
] as const)('a stop answered with $code retires: $retired', async ({ code, retired }, t) => {
  await withServer(t, serveVideo, async (world) => {
    await start(world, path.join(world.root, 'demo.mp4'));
    const binding = await bind(world, request(world, 'record', ['stop']));
    await binding.settle({ ok: false, error: { code, message: 'stop failed' } });
    expect(grantCount(world)).toBe(retired ? 0 : 1);
  });
});

// 6. Closes: batch and partial batch closes retire, and only the generation bound at dispatch.
test.for([
  { name: 'a batch close', outcome: { ok: true, data: { results: [{ command: 'close' }] } } },
  {
    name: 'a partial batch whose close step completed',
    outcome: {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'x',
        details: { partialResults: [{ command: 'close' }] },
      },
    },
  },
] as const)('$name retires only the grants bound at dispatch', async ({ outcome }, t) => {
  await withServer(t, serveVideo, async (world) => {
    await start(world, path.join(world.root, 'old.mp4'));
    const batch = request(world, 'batch', [], {});
    const binding = await bind(world, {
      ...batch,
      flags: { batchSteps: [{ command: 'snapshot' }, { command: 'close' }] },
    });
    // A start that lands after the close was dispatched belongs to the next generation.
    await start(world, path.join(world.root, 'old.mp4'));
    await binding.settle(outcome as Parameters<CaptureBinding['settle']>[0]);
    expect(grantCount(world)).toBe(1);
  });
});

// 7. A stop binds before dispatch: a newer start cannot authorize or be retired by it.
test('an in-flight stop neither uses nor retires a newer start with the same destination', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const req = request(world, 'record', ['stop']);
    const binding = await bind(world, req);
    const granted = path.join(world.root, 'demo.mp4');
    await start(world, granted);
    const response = await materialize(world, req, binding, {
      ok: true,
      data: { artifacts: [artifact({ field: 'outPath', localPath: granted })] },
    });
    expect(response.ok && response.data?.outPath).toBe(path.join(world.cwd, 'x.mp4'));
    expect(fs.existsSync(granted)).toBe(false);
    expect(grantCount(world)).toBe(1);
  });
});

// 8. A store that cannot be created degrades the start instead of blocking it.
test('an unusable state directory degrades the start with a typed warning', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    fs.mkdirSync(world.stateDir, { recursive: true });
    fs.writeFileSync(path.join(world.stateDir, 'remote-connections'), 'not a directory');
    const req = startRequest(world, path.join(world.root, 'demo.mp4'));
    const started = await materialize(world, req, await bind(world, req), { ok: true, data: {} });
    expect(started.ok && started.data?.recordingDestinationWarnings).toEqual([
      { reason: 'capture_destination_store_unavailable' },
    ]);
    expect(started.ok && started.data?.warnings).toHaveLength(1);
  });
});

// 9. Refused and unanswered starts never evict an accepted grant.
test.for(['refused', 'unknown'] as const)(
  'sixteen %s starts keep the live grant',
  async (answer, t) => {
    await withServer(t, serveVideo, async (world) => {
      const live = path.join(world.root, 'live.mp4');
      await start(world, live);
      for (let index = 0; index < 16; index += 1) {
        await start(world, path.join(world.root, `attempt-${index}.mp4`), answer);
      }
      const data = await stop(world, live);
      expect(data.outPath).toBe(live);
      expect(fs.readFileSync(live, 'utf8')).toBe('video-bytes');
    });
  },
);

test('a destination over the per-record cap degrades the start', async (t) => {
  await withServer(t, serveVideo, async (world) => {
    const req = startRequest(world, `/${'x'.repeat(64 * 1024)}`);
    const started = await materialize(world, req, await bind(world, req), { ok: true, data: {} });
    expect(started.ok && started.data?.recordingDestinationWarnings).toEqual([
      { reason: 'capture_destination_store_unavailable' },
    ]);
    expect(grantCount(world)).toBe(0);
  });
});
