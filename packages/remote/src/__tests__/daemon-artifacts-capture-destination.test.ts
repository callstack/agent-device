// #4518: a remote `record stop` writes a daemon `localPath` only when it derives from a destination
// that this client saved at `record start` for the same scope. The daemon response is untrusted.
// These tests drive the real save/materialize seams against a loopback server with owned
// temporary files only.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import { expect, test, vi } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { materializeRemoteArtifacts, saveCaptureStartDestination } from '../daemon-artifacts.ts';
import { readCaptureDestinations, saveCaptureDestination } from '../capture-destination.ts';
import { STALE_RECORD_MS } from '../remote-state-record-lock.ts';

type World = { root: string; stateDir: string; cwd: string; baseUrl: string };

function makeWorld(prefix: string, port: number): World {
  const root = fs.realpathSync(mkdtempForTestSync(prefix));
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  return { root, stateDir: path.join(root, 'state'), cwd, baseUrl: `http://127.0.0.1:${port}` };
}

function request(
  world: World,
  command: string,
  positionals: string[],
  session = 'capture',
  meta: DaemonWireRequest['meta'] = {},
): DaemonWireRequest {
  return { token: 'secret', command, session, positionals, meta: { cwd: world.cwd, ...meta } };
}

function artifact(partial: Partial<DaemonArtifact> & { field: string }): DaemonArtifact {
  return { artifactId: 'a1', path: '/daemon/x', fileName: 'x', ...partial } as DaemonArtifact;
}

async function saveStart(world: World, destination: string, session = 'capture'): Promise<void> {
  await saveCaptureStartDestination(
    request(world, 'record', ['start'], session, { clientArtifactPaths: { outPath: destination } }),
    { baseUrl: world.baseUrl, token: 'secret' },
    world.stateDir,
  );
}

async function materialize(
  world: World,
  req: DaemonWireRequest,
  artifacts: DaemonArtifact[],
): Promise<DaemonResponse> {
  return await materializeRemoteArtifacts(
    { baseUrl: world.baseUrl, token: 'secret' },
    req,
    { ok: true, data: { artifacts } },
    createTestHostEnvironment(),
    world.stateDir,
  );
}

function saved(world: World, session = 'capture'): string[] {
  return readCaptureDestinations({
    stateDir: world.stateDir,
    baseUrl: world.baseUrl,
    req: request(world, 'record', ['stop'], session),
  });
}

async function withServer(
  t: Parameters<typeof skipWhenLoopbackUnavailable>[0],
  handler: http.RequestListener,
  run: (port: number) => Promise<void>,
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t, 'capture destination')) return;
  const server = http.createServer(handler);
  try {
    await run(await listenOnLoopback(server));
  } finally {
    await closeLoopbackServer(server);
  }
}

test('a stop in another cwd writes the saved destination and its derivations, then retires it', async (t) => {
  await withServer(
    t,
    (_req, res) => res.end('video-bytes'),
    async (port) => {
      const world = makeWorld('agent-device-capture-destination-ok-', port);
      const granted = path.join(world.root, 'clips', 'demo');
      await saveStart(world, granted);
      expect(saved(world)).toEqual([granted]);

      const otherCwd = path.join(world.root, 'other-cwd');
      fs.mkdirSync(otherCwd);
      const chunkPath = `${granted}.part-002.mp4`;
      const telemetryPath = `${granted}.gesture-telemetry.json`;
      const response = await materialize(
        world,
        request(world, 'record', ['stop'], 'capture', { cwd: otherCwd }),
        [
          artifact({ field: 'outPath', localPath: `${granted}.mp4`, fileName: 'demo.mp4' }),
          artifact({ artifactId: 'c2', field: 'chunkPath', localPath: chunkPath }),
          artifact({ artifactId: 't', field: 'telemetryPath', localPath: telemetryPath }),
        ],
      );
      expect(response.ok && response.data?.outPath).toBe(`${granted}.mp4`);
      for (const file of [`${granted}.mp4`, chunkPath, telemetryPath]) {
        expect(fs.readFileSync(file, 'utf8')).toBe('video-bytes');
      }
      expect(fs.readdirSync(otherCwd)).toEqual([]);
      expect(saved(world)).toEqual([]);
    },
  );
});

test.for([
  { name: 'a path outside every saved derivation', localPath: 'hostile.mp4' },
  { name: 'a sibling that is not a chunk', localPath: 'demo.evil.mp4' },
  { name: "another session's saved destination", localPath: 'other.mp4' },
])('a stop refuses $name and writes the contained cwd name', async (testCase, t) => {
  await withServer(
    t,
    (_req, res) => res.end('video-bytes'),
    async (port) => {
      const world = makeWorld('agent-device-capture-destination-refused-', port);
      const clips = path.join(world.root, 'clips');
      await saveStart(world, path.join(clips, 'demo'));
      await saveStart(world, path.join(clips, 'other.mp4'), 'elsewhere');
      const hostile = path.join(clips, testCase.localPath);

      const response = await materialize(world, request(world, 'record', ['stop']), [
        artifact({ field: 'outPath', localPath: hostile, fileName: 'video.mp4' }),
      ]);
      expect(response.ok && response.data?.outPath).toBe(path.join(world.cwd, 'video.mp4'));
      expect(fs.readFileSync(path.join(world.cwd, 'video.mp4'), 'utf8')).toBe('video-bytes');
      expect(fs.existsSync(hostile)).toBe(false);
      // A refused path uses no saved destination, so none is retired.
      expect(saved(world)).toEqual([path.join(clips, 'demo')]);
      expect(saved(world, 'elsewhere')).toEqual([path.join(clips, 'other.mp4')]);
    },
  );
});

test('a stop whose download fails keeps the destination for a retried stop', async (t) => {
  let failArtifacts = true;
  await withServer(
    t,
    (_req, res) => {
      if (failArtifacts) res.writeHead(500);
      res.end(failArtifacts ? 'down' : 'video-bytes');
    },
    async (port) => {
      const world = makeWorld('agent-device-capture-destination-retry-', port);
      const granted = path.join(world.root, 'demo.mp4');
      await saveStart(world, granted);
      const stop = () =>
        materialize(world, request(world, 'record', ['stop']), [
          artifact({ field: 'outPath', localPath: granted }),
        ]);
      await expect(stop()).rejects.toThrow();
      expect(saved(world)).toEqual([granted]);

      failArtifacts = false;
      const response = await stop();
      expect(response.ok && response.data?.outPath).toBe(granted);
      expect(saved(world)).toEqual([]);
    },
  );
});

test("a confirmed close retires its own scope and never another scope's", async (t) => {
  await withServer(
    t,
    (_req, res) => res.end(),
    async (port) => {
      const world = makeWorld('agent-device-capture-destination-close-', port);
      await saveStart(world, path.join(world.root, 'a.mp4'), 'closing');
      await saveStart(world, path.join(world.root, 'b.mp4'), 'closing');
      await saveStart(world, path.join(world.root, 'c.mp4'), 'elsewhere');

      await materialize(world, request(world, 'close', [], 'closing'), []);
      expect(saved(world, 'closing')).toEqual([]);
      expect(saved(world, 'elsewhere')).toEqual([path.join(world.root, 'c.mp4')]);
    },
  );
});

test('a full scope evicts only its own oldest record, and stale records expire', async () => {
  const world = makeWorld('agent-device-capture-destination-bounds-', 1);
  const save = (destination: string, session = 'capture') =>
    saveCaptureDestination({
      stateDir: world.stateDir,
      baseUrl: world.baseUrl,
      req: request(world, 'record', ['start'], session),
      destination,
    });
  await save('/keep/other.mp4', 'elsewhere');
  const names = Array.from({ length: 17 }, (_, index) => `/clips/${index}.mp4`);
  for (const name of names) await save(name);
  expect(saved(world)).toEqual(names.slice(1));
  expect(saved(world, 'elsewhere')).toEqual(['/keep/other.mp4']);

  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + STALE_RECORD_MS + 1);
  try {
    expect(saved(world)).toEqual([]);
  } finally {
    vi.restoreAllMocks();
  }
});

test('a destination over the per-record cap is refused before dispatch', async () => {
  const world = makeWorld('agent-device-capture-destination-cap-', 1);
  await expect(saveStart(world, `/${'x'.repeat(64 * 1024)}`)).rejects.toMatchObject({
    details: { reason: 'capture_destination_too_large' },
  });
  expect(saved(world)).toEqual([]);
});
