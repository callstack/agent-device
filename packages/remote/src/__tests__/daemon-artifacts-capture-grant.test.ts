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
import { materializeRemoteArtifacts, prepareRemoteRequestArtifacts } from '../daemon-artifacts.ts';
import {
  admitCaptureGrant,
  listOpenCaptureGrantsInScope,
  readCaptureGrantById,
  settleCaptureGrant,
  type CaptureGrant,
} from '../capture-grant.ts';

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
 * Runs a record start exactly as the CLI does: prepare persists the grant BEFORE any response
 * exists and returns the minted grant ID the transport would put on the wire. `answer` simulates
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
    world.stateDir,
  );
  const grantId = prepared.captureGrantId;
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
    expect(grant?.state).toBe('open');

    // The stop runs in a separate CLI process with a different cwd; the daemon echoes the grant ID
    // from the accepted capture and the extension-appended destination as localPath.
    const otherCwd = path.join(world.root, 'other-cwd');
    fs.mkdirSync(otherCwd, { recursive: true });
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
        ],
        { captureGrantId: grantId },
      ),
    );
    expect(response.ok && response.data?.outPath).toBe(`${granted}.mp4`);
    expect(fs.readFileSync(`${granted}.mp4`, 'utf8')).toBe('video-bytes');
    expect(fs.existsSync(path.join(otherCwd, 'demo.mp4'))).toBe(false);

    // The matched stop settled the grant as finished.
    await settleCaptureGrant({
      stateDir: world.stateDir,
      baseUrl: world.endpoint(port).baseUrl,
      req: stopRequest(world),
      slot: 'record',
      grantId,
      outcome: 'finished',
    });
    expect(readGrant(world, port, stopRequest(world), grantId)?.state).toBe('finished');
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

    // The newer grant is still open and intact.
    expect(
      readCaptureGrantById({
        stateDir: world.stateDir,
        baseUrl: world.endpoint(port).baseUrl,
        req: stopRequest(world),
        slot: 'record',
        grantId: second.grantId,
      })?.state,
    ).toBe('open');
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

    // The grant the client persisted is untouched: no echo, so nothing settled it.
    expect(
      readCaptureGrantById({
        stateDir: world.stateDir,
        baseUrl: world.endpoint(port).baseUrl,
        req: stopRequest(world),
        slot: 'record',
        grantId,
      })?.state,
    ).toBe('open');
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

test('aggregate admission refuses beyond 64 records and the bounded sweep reclaims only expired non-recovery records', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant admission')) return;
  const world = makeWorld('agent-device-capture-grant-cap-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const baseUrl = world.endpoint(port).baseUrl;
    const makeReq = (session: string): DaemonWireRequest => ({
      token: 'secret',
      command: 'record',
      session,
      positionals: ['start', `clips/${session}`],
      meta: { cwd: world.root },
    });
    // 64 records admitted.
    const admittedIds = new Map<string, string>();
    for (let i = 0; i < 64; i += 1) {
      const grantId = await admitCaptureGrant({
        stateDir: world.stateDir,
        baseUrl,
        req: makeReq(`s${i}`),
        slot: 'record',
        destination: path.join(world.root, 'clips', `s${i}`),
      });
      admittedIds.set(`s${i}`, grantId);
    }
    // The 65th is refused before dispatch with a typed error.
    await expect(
      admitCaptureGrant({
        stateDir: world.stateDir,
        baseUrl,
        req: makeReq('overflow'),
        slot: 'record',
        destination: path.join(world.root, 'clips', 'overflow'),
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'capture_grant_admission_refused', limit: 64 }),
    });

    // A pending-recovery record is never swept, even when ancient.
    const protectedId = '11111111-1111-4111-8111-111111111111';
    fs.mkdirSync(path.join(world.stateDir, 'remote-connections', 'capture-grants'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(world.stateDir, 'remote-connections', 'capture-grants', `${protectedId}.json`),
      JSON.stringify({
        version: 1,
        grantId: protectedId,
        slot: 'record',
        destination: path.join(world.root, 'clips', 'protected'),
        scope: { baseUrl, tenantId: '', runId: '', leaseId: '', session: 's0' },
        state: 'pending-recovery',
        createdAtMs: 0,
        updatedAtMs: 0,
      }),
    );
    // Still refused: the sweep may not remove the protected record.
    await expect(
      admitCaptureGrant({
        stateDir: world.stateDir,
        baseUrl,
        req: makeReq('overflow'),
        slot: 'record',
        destination: path.join(world.root, 'clips', 'overflow'),
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'capture_grant_admission_refused' }),
    });

    // An expired KNOWN-OPEN record is retained evidence too: the sweep removes finished
    // records only, even when an open one is ancient.
    const staleOpenFile = path.join(
      world.stateDir,
      'remote-connections',
      'capture-grants',
      `${admittedIds.get('s63')}.json`,
    );
    {
      const record = JSON.parse(fs.readFileSync(staleOpenFile, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(staleOpenFile, JSON.stringify({ ...record, updatedAtMs: 0 }));
    }

    // Expired FINISHED records are reclaimed by the sweep, freeing room (the protected
    // pending-recovery record and the stale open record still count against the cap).
    const agedFiles: string[] = [];
    for (const session of ['s0', 's1']) {
      const reqN = makeReq(session);
      const grantIdN = admittedIds.get(session);
      expect(grantIdN).toBeDefined();
      await settleCaptureGrant({
        stateDir: world.stateDir,
        baseUrl,
        req: reqN,
        slot: 'record',
        grantId: grantIdN,
        outcome: 'finished',
      });
      // Age it past the staleness horizon.
      const file = path.join(
        world.stateDir,
        'remote-connections',
        'capture-grants',
        `${grantIdN}.json`,
      );
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(file, JSON.stringify({ ...record, updatedAtMs: 0 }));
      agedFiles.push(file);
    }
    const admitted = await admitCaptureGrant({
      stateDir: world.stateDir,
      baseUrl,
      req: makeReq('overflow'),
      slot: 'record',
      destination: path.join(world.root, 'clips', 'overflow'),
    });
    expect(
      readCaptureGrantById({
        stateDir: world.stateDir,
        baseUrl,
        req: makeReq('overflow'),
        slot: 'record',
        grantId: admitted,
      })?.destination,
    ).toBe(path.join(world.root, 'clips', 'overflow'));
    for (const file of agedFiles) expect(fs.existsSync(file)).toBe(false);
    // The pending-recovery record survived the sweep.
    expect(
      fs.existsSync(
        path.join(world.stateDir, 'remote-connections', 'capture-grants', `${protectedId}.json`),
      ),
    ).toBe(true);
    // ...and so did the stale KNOWN-OPEN record: the sweep never touches retained open evidence.
    expect(fs.existsSync(staleOpenFile)).toBe(true);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('aggregate admission reserves bytes for later grant state changes', async (t) => {
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
    const destination = record.destination + 'x'.repeat(limit - 2 * original.byteLength);
    fs.writeFileSync(file, `${JSON.stringify({ ...record, destination })}\n`);
    expect(fs.statSync(file).size + original.byteLength).toBe(limit);

    // The incoming record fits exactly as written, but would leave no room to settle either grant.
    await expect(admitCaptureGrant(options)).rejects.toMatchObject({
      details: expect.objectContaining({
        reason: 'capture_grant_admission_refused',
        limit,
      }),
    });
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

test('a rejected start settles only the grant its own request named; uncertain records stay', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant failed start')) return;
  const world = makeWorld('agent-device-capture-grant-failed-start-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const first = await runStart(world, port, 'clips/first', 'withheld');
    const second = await runStart(world, port, 'clips/second', 'withheld');
    // The second start's request carried its own grant ID and the daemon answered an error:
    // exactly that record is settled finished (bounded cleanup matching the request evidence).
    const { noteFailedCaptureStart } = await import('../daemon-artifacts.ts');
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
      })?.state,
    ).toBe('finished');
    // The unrelated withheld start's grant is untouched.
    expect(
      readCaptureGrantById({
        stateDir: world.stateDir,
        baseUrl: world.endpoint(port).baseUrl,
        req: stopRequest(world),
        slot: 'record',
        grantId: first.grantId,
      })?.state,
    ).toBe('open');
  } finally {
    await closeLoopbackServer(server);
  }
});

test('an uncertain finish marks every open grant of the scope pending-recovery without guessing one', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'capture grant pending recovery')) return;
  const world = makeWorld('agent-device-capture-grant-recovery-');
  const server = http.createServer((_req, res) => res.end('bytes'));
  try {
    const port = await listenOnLoopback(server);
    const first = await runStart(world, port, 'clips/first', 'withheld');
    const second = await runStart(world, port, 'clips/second', 'withheld');
    // Both starts are accepted-but-answerless: two open grants in one scope.
    expect(
      listOpenCaptureGrantsInScope({
        stateDir: world.stateDir,
        baseUrl: world.endpoint(port).baseUrl,
        req: stopRequest(world),
        slot: 'record',
      })
        .map((grant) => grant.grantId)
        .sort(),
    ).toEqual([first.grantId, second.grantId].sort());
    // An error answer to the stop leaves the outcome uncertain: BOTH become pending-recovery.
    const { noteUncertainFinishingCapture } = await import('../daemon-artifacts.ts');
    await noteUncertainFinishingCapture(world.endpoint(port), stopRequest(world), world.stateDir);
    for (const grantId of [first.grantId, second.grantId]) {
      expect(
        readCaptureGrantById({
          stateDir: world.stateDir,
          baseUrl: world.endpoint(port).baseUrl,
          req: stopRequest(world),
          slot: 'record',
          grantId,
        })?.state,
      ).toBe('pending-recovery');
    }
  } finally {
    await closeLoopbackServer(server);
  }
});
