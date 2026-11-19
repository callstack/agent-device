// #4518, benign side: a remote capture's finishing action may write only where THIS client
// persisted the destination BEFORE dispatching the start — under the remote-connections state
// owner, keyed by the immutable grant ID the client minted for that one attempt — and only to
// paths derived from that grant. The daemon echoes the grant ID from the accepted capture, which
// the client matches; a missing or unmatched ID never authorizes a response localPath. These tests
// drive the real prepare/materialize seams against a loopback server with owned temporary files
// only: no hostile payloads, no symlinks, no real user paths, no devices.

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
  admitCaptureStartGrant,
  materializeRemoteArtifacts,
  noteFailedCaptureStart,
  prepareRemoteRequestArtifacts,
  retireClosedScopeCaptureGrants,
} from '../daemon-artifacts.ts';
import {
  admitCaptureGrant,
  authorizedCaptureLocalPath,
  readCaptureGrantById,
  releaseCaptureGrant,
  retireCaptureGrantsInScope,
  type CaptureGrant,
} from '../capture-grant.ts';
import { STALE_RECORD_MS } from '../remote-state-record-lock.ts';

const signal = new AbortController().signal;

type World = {
  root: string;
  stateDir: string;
  cwd: string;
  endpoint: (port: number) => { baseUrl: string; token: string };
};

function makeWorld(prefix: string): World {
  const root = fs.realpathSync(mkdtempForTestSync(prefix));
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    root,
    stateDir: path.join(root, 'state'),
    cwd,
    endpoint: (port) => ({ baseUrl: `http://127.0.0.1:${port}`, token: 'secret' }),
  };
}

function artifact(partial: Partial<DaemonArtifact> & { field: string }): DaemonArtifact {
  return {
    artifactId: 'a1',
    path: '/daemon/x',
    fileName: 'x',
    ...partial,
  } as DaemonArtifact;
}

function stopRequest(world: World, overrides?: Partial<DaemonWireRequest>): DaemonWireRequest {
  return {
    token: 'secret',
    command: 'record',
    session: 'capture',
    positionals: ['stop'],
    meta: { cwd: world.cwd },
    ...overrides,
  };
}

function okResponse(
  artifacts: DaemonArtifact[],
  extraData: Record<string, unknown> = {},
): Extract<DaemonResponse, { ok: true }> {
  return { ok: true, data: { ...extraData, artifacts } };
}

/**
 * Runs the preparation and dispatch admission seams for a record start. `answer` simulates
 * the daemon's start answer: 'withheld' never materializes a response (an accepted start whose
 * answer was lost), 'ok'/'error' materialize one.
 */
async function runStart(
  world: World,
  port: number,
  destination: string,
  answer: 'withheld' | 'ok' | 'error',
  session = 'capture',
) {
  const endpoint = world.endpoint(port);
  const prepared = await prepareRemoteRequestArtifacts(
    {
      command: 'record',
      session,
      positionals: ['start', destination],
      meta: { cwd: world.root },
    },
    endpoint,
    signal,
    createTestHostEnvironment(),
  );
  const grantId = await admitCaptureStartGrant(
    {
      token: endpoint.token,
      command: 'record',
      session,
      positionals: prepared.positionals,
      meta: { cwd: world.root, clientArtifactPaths: prepared.clientArtifactPaths },
    },
    endpoint,
    world.stateDir,
  );
  expect(grantId).toBeDefined();
  const granted = prepared.clientArtifactPaths?.outPath as string;
  if (answer !== 'withheld') {
    const request: DaemonWireRequest = {
      token: 'secret',
      command: 'record',
      session,
      positionals: ['start', destination],
      meta: {
        cwd: world.root,
        clientArtifactPaths: prepared.clientArtifactPaths,
        captureGrantId: grantId,
      },
    };
    if (answer === 'ok') {
      await materializeRemoteArtifacts(
        endpoint,
        request,
        { ok: true, data: {} },
        createTestHostEnvironment(),
        world.stateDir,
      );
    }
  }
  return { grantId: grantId as string, granted };
}

async function materialize(
  world: World,
  port: number,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
) {
  return await materializeRemoteArtifacts(
    world.endpoint(port),
    req,
    response,
    createTestHostEnvironment(),
    world.stateDir,
  );
}

function readGrant(
  world: World,
  port: number,
  req: DaemonWireRequest,
  grantId: string | undefined,
): CaptureGrant | undefined {
  return readCaptureGrantById({
    stateDir: world.stateDir,
    baseUrl: world.endpoint(port).baseUrl,
    req,
    slot: 'record',
    grantId,
  });
}

test('a record start persists its grant before dispatch, and an accepted start with a withheld response still authorizes the later stop in a separate process and cwd', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant withheld response')) return;
  const world = makeWorld('agent-device-capture-grant-withheld-');
  const server = http.createServer((_req, res) => res.end('video-bytes'));
  try {
    const port = await listenOnLoopback(server);
    const { grantId, granted } = await runStart(world, port, 'clips/demo', 'withheld');
    expect(granted).toBe(path.join(world.root, 'clips', 'demo'));

    // The grant is durable before any answer: a fresh "process" (same state dir, new cwd) reads it.
    const startReq = stopRequest(world, { positionals: ['start', 'clips/demo'] });
    const grant = readGrant(world, port, startReq, grantId);
    expect(grant?.destination).toBe(granted);

    // The stop runs in a separate CLI process with a different cwd; the daemon echoes the grant ID
    // from the accepted capture and the extension-appended destination as localPath.
    const otherCwd = path.join(world.root, 'other-cwd');
    fs.mkdirSync(otherCwd, { recursive: true });
    const chunkPath = `${granted}.part-002.mp4`;
    const telemetryPath = `${granted}.gesture-telemetry.json`;
    const response = await materialize(
      world,
      port,
      stopRequest(world, { meta: { cwd: otherCwd } }),
      okResponse(
        [
          artifact({
            field: 'outPath',
            localPath: `${granted}.mp4`,
            fileName: 'demo.mp4',
            captureGrantId: grantId,
          }),
          artifact({
            artifactId: 'chunk-002',
            field: 'chunkPath',
            localPath: chunkPath,
            fileName: 'demo.part-002.mp4',
            captureGrantId: grantId,
          }),
          artifact({
            artifactId: 'telemetry',
            field: 'telemetryPath',
            localPath: telemetryPath,
            fileName: 'demo.gesture-telemetry.json',
            captureGrantId: grantId,
          }),
        ],
        { captureGrantId: grantId },
      ),
    );
    expect(response.ok && response.data?.outPath).toBe(`${granted}.mp4`);
    expect(response.ok && response.data?.chunkPath).toBe(chunkPath);
    expect(response.ok && response.data?.telemetryPath).toBe(telemetryPath);
    expect(fs.readFileSync(`${granted}.mp4`, 'utf8')).toBe('video-bytes');
    expect(fs.readFileSync(chunkPath, 'utf8')).toBe('video-bytes');
    expect(fs.readFileSync(telemetryPath, 'utf8')).toBe('video-bytes');
    expect(fs.existsSync(path.join(otherCwd, 'demo.mp4'))).toBe(false);

    // The successful matching stop deleted the grant: a record never outlives its capture.
    expect(readGrant(world, port, stopRequest(world), grantId)).toBeUndefined();
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a rejected second start never displaces the first start grant', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant rejected start')) return;
  const world = makeWorld('agent-device-capture-grant-rejected-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const first = await runStart(world, port, 'clips/first', 'ok');
    const second = await runStart(world, port, 'clips/second', 'error');
    expect(second.grantId).not.toBe(first.grantId);

    // Stopping the FIRST capture still has its original grant and destination.
    const response = await materialize(
      world,
      port,
      stopRequest(world),
      okResponse(
        [
          artifact({
            field: 'outPath',
            localPath: `${first.granted}.mp4`,
            fileName: 'first.mp4',
            captureGrantId: first.grantId,
          }),
        ],
        { captureGrantId: first.grantId },
      ),
    );
    expect(response.ok && response.data?.outPath).toBe(`${first.granted}.mp4`);
    expect(fs.readFileSync(`${first.granted}.mp4`, 'utf8')).toBe('bytes');
    expect(fs.existsSync(path.join(world.root, 'clips', 'second.mp4'))).toBe(false);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a reordered acknowledgement cannot overwrite or extend a newer grant', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant reordered')) return;
  const world = makeWorld('agent-device-capture-grant-reordered-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const first = await runStart(world, port, 'clips/first', 'ok');
    const second = await runStart(world, port, 'clips/second', 'ok');

    const matchingGrant = readGrant(world, port, stopRequest(world), first.grantId);
    expect(matchingGrant?.destination).toBe(first.granted);
    expect(
      authorizedCaptureLocalPath({
        grant: matchingGrant,
        field: 'outPath',
        localPath: `${second.granted}.mp4`,
      }),
    ).toBeUndefined();

    // A late stop echoing the FIRST grant writes only to the first destination...
    const late = await materialize(
      world,
      port,
      stopRequest(world),
      okResponse(
        [
          artifact({
            field: 'outPath',
            localPath: `${first.granted}.mp4`,
            fileName: 'first.mp4',
            captureGrantId: first.grantId,
          }),
        ],
        { captureGrantId: first.grantId },
      ),
    );
    expect(late.ok && late.data?.outPath).toBe(`${first.granted}.mp4`);

    // ...and the same stop cannot claim the NEWER grant's destination: unmatched for it, refused.
    const overreach = await materialize(
      world,
      port,
      stopRequest(world),
      okResponse(
        [
          artifact({
            field: 'outPath',
            localPath: `${second.granted}.mp4`,
            fileName: 'second.mp4',
            captureGrantId: first.grantId,
          }),
        ],
        { captureGrantId: first.grantId },
      ),
    );
    expect(overreach.ok && overreach.data?.outPath).toBe(path.join(world.cwd, 'second.mp4'));
    expect(fs.existsSync(`${second.granted}.mp4`)).toBe(false);

    // The late matched stop deleted the first grant; the newer grant is still intact.
    expect(
      readCaptureGrantById({
        stateDir: world.stateDir,
        baseUrl: world.endpoint(port).baseUrl,
        req: stopRequest(world),
        slot: 'record',
        grantId: first.grantId,
      }),
    ).toBeUndefined();
    expect(
      readCaptureGrantById({
        stateDir: world.stateDir,
        baseUrl: world.endpoint(port).baseUrl,
        req: stopRequest(world),
        slot: 'record',
        grantId: second.grantId,
      }),
    ).toBeDefined();
  } finally {
    await closeLoopbackServer(server);
  }
});

test('an older daemon without a grant echo authorizes no persisted destination: every response path stays in cwd, disclosed', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant legacy echo')) return;
  const world = makeWorld('agent-device-capture-grant-legacy-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const { grantId, granted } = await runStart(world, port, 'clips/demo.mp4', 'ok');

    // No captureGrantId echoed (older daemon): there is no scope-open fallback, so even the
    // granted destination's derivations are refused to the contained cwd-local name.
    const response = await materialize(
      world,
      port,
      stopRequest(world),
      okResponse([
        artifact({ field: 'outPath', localPath: granted, fileName: 'demo.mp4' }),
        artifact({
          field: 'telemetryPath',
          localPath: path.join(world.root, 'clips', 'demo.gesture-telemetry.json'),
          fileName: 'demo.gesture-telemetry.json',
        }),
        artifact({
          field: 'chunkPath',
          localPath: path.join(world.root, 'clips', 'demo.part-002.mp4'),
          fileName: 'demo.part-002.mp4',
        }),
      ]),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data?.outPath).toBe(path.join(world.cwd, 'demo.mp4'));
    expect(response.data?.telemetryPath).toBe(path.join(world.cwd, 'demo.gesture-telemetry.json'));
    const chunks = ((response.data?.artifacts ?? []) as DaemonArtifact[])
      .filter((a) => a.field === 'chunkPath')
      .map((a) => a.localPath);
    expect(chunks).toEqual([path.join(world.cwd, 'demo.part-002.mp4')]);
    expect(fs.existsSync(granted)).toBe(false);
    expect(fs.existsSync(path.join(world.root, 'clips', 'demo.mp4'))).toBe(false);

    const req = stopRequest(world);
    expect(readGrant(world, port, req, grantId)).toBeDefined();
    const dir = path.join(world.stateDir, 'remote-connections', 'capture-grants');
    const oldest = new Date(Date.now() - 10_000);
    fs.utimesSync(path.join(dir, `${grantId}.json`), oldest, oldest);
    const later = [];
    for (let i = 1; i <= 64; i += 1) {
      later.push((await runStart(world, port, `clips/next-${i}`, 'withheld')).grantId);
    }
    expect(readGrant(world, port, req, grantId)).toBeUndefined();
    expect(readGrant(world, port, req, later[0])).toBeDefined();
    expect(readGrant(world, port, req, later[63])).toBeDefined();
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(64);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a stop with an unmatched grant ID or without any grant never trusts localPath', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant unmatched')) return;
  const world = makeWorld('agent-device-capture-grant-unmatched-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const { granted } = await runStart(world, port, 'clips/demo', 'ok');
    const ungranted = path.join(world.root, 'elsewhere', 'clip.mp4');

    // A well-formed but unknown grant ID: refused to cwd.
    const unmatched = await materialize(
      world,
      port,
      stopRequest(world),
      okResponse(
        [
          artifact({
            field: 'outPath',
            localPath: ungranted,
            fileName: 'clip.mp4',
            captureGrantId: '00000000-0000-4000-8000-000000000000',
          }),
        ],
        { captureGrantId: '00000000-0000-4000-8000-000000000000' },
      ),
    );
    expect(unmatched.ok && unmatched.data?.outPath).toBe(path.join(world.cwd, 'clip.mp4'));
    expect(fs.existsSync(path.join(world.root, 'elsewhere'))).toBe(false);

    // No grant at all (fresh state dir): refused to cwd as well.
    const bareWorld = makeWorld('agent-device-capture-grant-missing-');
    const bare = await materialize(
      bareWorld,
      port,
      stopRequest(bareWorld),
      okResponse([artifact({ field: 'outPath', localPath: ungranted, fileName: 'clip.mp4' })]),
    );
    expect(bare.ok && bare.data?.outPath).toBe(path.join(bareWorld.cwd, 'clip.mp4'));
    expect(fs.existsSync(path.join(world.root, 'elsewhere'))).toBe(false);
    expect(granted).toBe(path.join(world.root, 'clips', 'demo'));
  } finally {
    await closeLoopbackServer(server);
  }
});

test('matching releases and the stale sweep free room while fresh grants survive', async () => {
  const world = makeWorld('agent-device-capture-grant-cap-');
  const baseUrl = world.endpoint(1).baseUrl;
  const req = stopRequest(world, { positionals: ['start', 'clips/demo'] });
  const options = {
    stateDir: world.stateDir,
    baseUrl,
    req,
    slot: 'record' as const,
    destination: path.join(world.root, 'clips', 'demo'),
  };
  const grantsDir = path.join(world.stateDir, 'remote-connections', 'capture-grants');
  const grantFile = (grantId: string) => path.join(grantsDir, `${grantId}.json`);
  const released = await admitCaptureGrant(options);
  await releaseCaptureGrant({ ...options, grantId: released });
  expect(fs.existsSync(grantFile(released))).toBe(false);

  const staleGrant = await admitCaptureGrant(options);
  const fresh = await admitCaptureGrant(options);
  const ancient = new Date(Date.now() - STALE_RECORD_MS - 60_000);
  fs.utimesSync(grantFile(staleGrant), ancient, ancient);
  fs.writeFileSync(path.join(grantsDir, 'notes.txt'), 'not a grant record');
  fs.utimesSync(path.join(grantsDir, 'notes.txt'), ancient, ancient);
  const admitted = await admitCaptureGrant(options);

  expect(fs.existsSync(grantFile(staleGrant))).toBe(false);
  expect(fs.existsSync(grantFile(fresh))).toBe(true);
  expect(fs.existsSync(grantFile(admitted))).toBe(true);
  expect(fs.existsSync(path.join(grantsDir, 'notes.txt'))).toBe(true);
});

test('admission evicts old metadata to fit the byte cap and refuses an individually oversized grant', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant byte cap')) return;
  const world = makeWorld('agent-device-capture-grant-bytes-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const baseUrl = world.endpoint(port).baseUrl;
    const req: DaemonWireRequest = {
      token: 'secret',
      command: 'record',
      session: 'capture',
      positionals: ['start', 'clips/demo'],
      meta: { cwd: world.root },
    };
    const options = {
      stateDir: world.stateDir,
      baseUrl,
      req,
      slot: 'record' as const,
      destination: path.join(world.root, 'clips', 'demo'),
    };
    const limit = 8 * 1024 * 1024;
    const grantId = await admitCaptureGrant(options);
    const file = path.join(
      world.stateDir,
      'remote-connections',
      'capture-grants',
      `${grantId}.json`,
    );
    const original = fs.readFileSync(file);
    const record = JSON.parse(original.toString('utf8')) as CaptureGrant;
    // Pad the one record until the store's total serialized metadata reaches the limit.
    const destination = record.destination + 'x'.repeat(limit - original.byteLength);
    fs.writeFileSync(file, `${JSON.stringify({ ...record, destination })}\n`);
    expect(fs.statSync(file).size).toBe(limit);

    const latest = await admitCaptureGrant(options);
    expect(fs.existsSync(file)).toBe(false);
    expect(readGrant(world, port, req, latest)?.destination).toBe(options.destination);

    await expect(
      admitCaptureGrant({ ...options, destination: destination + 'x' }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        reason: 'capture_grant_admission_refused',
        limit,
      }),
    });
    expect(readGrant(world, port, req, latest)).toBeDefined();
  } finally {
    await closeLoopbackServer(server);
  }
});

test('an uncertain census refuses admission instead of counting an unreadable store as zero', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant uncertain census')) return;
  const world = makeWorld('agent-device-capture-grant-census-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const baseUrl = world.endpoint(port).baseUrl;
    const req: DaemonWireRequest = {
      token: 'secret',
      command: 'record',
      session: 's0',
      positionals: ['start', 'clips/s0'],
      meta: { cwd: world.root },
    };
    // A grants path that is not a directory: the census cannot read it, so it is uncertain.
    fs.mkdirSync(path.join(world.stateDir, 'remote-connections'), { recursive: true });
    fs.writeFileSync(path.join(world.stateDir, 'remote-connections', 'capture-grants'), 'x');
    await expect(
      admitCaptureGrant({
        stateDir: world.stateDir,
        baseUrl,
        req,
        slot: 'record',
        destination: path.join(world.root, 'clips', 's0'),
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'capture_grant_census_uncertain' }),
    });
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a rejected start releases only the grant its own request named; uncertain records stay', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant failed start')) return;
  const world = makeWorld('agent-device-capture-grant-failed-start-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const first = await runStart(world, port, 'clips/first', 'withheld');
    const second = await runStart(world, port, 'clips/second', 'withheld');
    // The second start's request carried its own grant ID and the daemon answered an error:
    // exactly that record is released.
    await noteFailedCaptureStart(
      world.endpoint(port),
      {
        token: 'secret',
        command: 'record',
        session: 'capture',
        positionals: ['start', 'clips/second'],
        meta: { cwd: world.root, captureGrantId: second.grantId },
      },
      world.stateDir,
    );
    expect(
      readCaptureGrantById({
        stateDir: world.stateDir,
        baseUrl: world.endpoint(port).baseUrl,
        req: stopRequest(world),
        slot: 'record',
        grantId: second.grantId,
      }),
    ).toBeUndefined();
    // The unrelated withheld start's grant is untouched.
    expect(
      readCaptureGrantById({
        stateDir: world.stateDir,
        baseUrl: world.endpoint(port).baseUrl,
        req: stopRequest(world),
        slot: 'record',
        grantId: first.grantId,
      }),
    ).toBeDefined();
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a matching stop echo with no artifacts still deletes the grant', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant echo-only stop')) return;
  const world = makeWorld('agent-device-capture-grant-echo-only-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const { grantId } = await runStart(world, port, 'clips/demo', 'withheld');
    // The daemon confirms the capture (echoes its grant ID) but the response carries no artifacts.
    const response = await materialize(
      world,
      port,
      stopRequest(world),
      okResponse([], { captureGrantId: grantId }),
    );
    expect(response.ok).toBe(true);
    expect(readGrant(world, port, stopRequest(world), grantId)).toBeUndefined();
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a matching stop whose artifact download fails keeps the grant so a retried stop can deliver', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant failed delivery')) return;
  const world = makeWorld('agent-device-capture-grant-failed-delivery-');
  // The artifact endpoint fails while `failArtifacts` is set, then serves the bytes.
  let failArtifacts = true;
  const server = http.createServer((req, res) => {
    if (failArtifacts && req.url?.includes('/artifacts/')) {
      res.writeHead(500);
      res.end('down');
      return;
    }
    res.end('video-bytes');
  });
  try {
    const port = await listenOnLoopback(server);
    const { grantId, granted } = await runStart(world, port, 'clips/demo', 'withheld');
    const stopResponse = () =>
      okResponse(
        [
          artifact({
            field: 'outPath',
            localPath: `${granted}.mp4`,
            fileName: 'demo.mp4',
            captureGrantId: grantId,
          }),
        ],
        { captureGrantId: grantId },
      );
    await expect(materialize(world, port, stopRequest(world), stopResponse())).rejects.toThrow();
    // Materialization failed on an answered response, so the grant is retained for the retry.
    expect(readGrant(world, port, stopRequest(world), grantId)).toBeDefined();
    expect(fs.existsSync(`${granted}.mp4`)).toBe(false);

    // The retried stop delivers to the granted destination and releases the grant.
    failArtifacts = false;
    const response = await materialize(world, port, stopRequest(world), stopResponse());
    expect(response.ok && response.data?.outPath).toBe(`${granted}.mp4`);
    expect(fs.readFileSync(`${granted}.mp4`, 'utf8')).toBe('video-bytes');
    expect(readGrant(world, port, stopRequest(world), grantId)).toBeUndefined();
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a successful close retires its own scope’s grants and never another scope’s; a failed close retires nothing', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant close')) return;
  const world = makeWorld('agent-device-capture-grant-close-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const baseUrl = world.endpoint(port).baseUrl;
    // Two grants in the closing session's scope, one in a different session's scope.
    const own = await runStart(world, port, 'clips/own-a', 'withheld', 'closing');
    const ownToo = await runStart(world, port, 'clips/own-b', 'withheld', 'closing');
    const other = await runStart(world, port, 'clips/other', 'withheld', 'elsewhere');
    const closeReq: DaemonWireRequest = {
      token: 'secret',
      command: 'close',
      session: 'closing',
      positionals: [],
      meta: { cwd: world.cwd },
    };
    const otherReq = stopRequest(world, { session: 'elsewhere' });
    const readOwn = (grantId: string) => readGrant(world, port, closeReq, grantId);
    const readOther = (grantId: string) => readGrant(world, port, otherReq, grantId);

    // A failed close (an error answer) runs no grant action: everything stays.
    await noteFailedCaptureStart(world.endpoint(port), closeReq, world.stateDir);
    expect(readOwn(own.grantId)).toBeDefined();
    expect(readOther(other.grantId)).toBeDefined();

    // The daemon confirmed the close: materializing its ok response retires the close's scope.
    const closed = await materialize(world, port, closeReq, okResponse([]));
    expect(closed.ok).toBe(true);
    expect(readOwn(own.grantId)).toBeUndefined();
    expect(readOwn(ownToo.grantId)).toBeUndefined();
    // The other scope's grant is untouched (cross-scope isolation).
    expect(readOther(other.grantId)).toBeDefined();

    // The store-level retire agrees: only the named scope is removed, whatever the command.
    await retireCaptureGrantsInScope({
      stateDir: world.stateDir,
      baseUrl,
      req: otherReq,
    });
    expect(readOther(other.grantId)).toBeUndefined();
    // A non-close request never triggers the retire on its own.
    const third = await runStart(world, port, 'clips/third', 'withheld', 'third');
    await retireClosedScopeCaptureGrants(world.endpoint(port), stopRequest(world), world.stateDir);
    expect(
      readGrant(world, port, stopRequest(world, { session: 'third' }), third.grantId),
    ).toBeDefined();
  } finally {
    await closeLoopbackServer(server);
  }
});
