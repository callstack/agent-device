import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { MIN_LEASE_WINDOW_MS } from '@agent-device/contracts/lease-scope';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { sendToDaemon } from '../../../src/daemon-client/daemon-client.ts';
import type { DaemonRequest } from '../../../src/daemon/daemon-request.ts';
import {
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';
import { PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS } from './test-timeouts.ts';

const LEASE_ID = 'lease-upload-beat';
const TOKEN = 'upload-beat-token';
const APK_BYTES = 4 * 1024 * 1024;
/** Renewed window the fake daemon reports; a third of it is the cadence the client beats on. */
const LEASE_WINDOW_MS = 3_000;
/**
 * A heartbeat round trip on a slow link.
 *
 * The number has to land between the two budgets the loop can be holding a beat to: longer than the
 * cadence it assumes before a window is known (1666ms, a third of the registry's five-second
 * minimum), and short enough to answer before that assumed cadence arms a third beat (3332ms).
 * Anything slower than the cadence and a beat budgeted at it is cut off before the answer lands, so
 * the test would pass on a budget sized to the wrong thing; anything past the third arrival and the
 * correct loop is caught with an extra beat too. This sits at the middle of that window so a loaded
 * runner has room on both sides.
 */
const SLOW_BEAT_MS = 2_500;
/** The window the fake daemon reports on the slow-link case, whose third is its cadence. */
const SLOW_BEAT_LEASE_WINDOW_MS = 30_000;
/** The cadence the loop assumes before any window is known: a third of the registry minimum. */
const ASSUMED_BEAT_INTERVAL_MS = Math.floor(MIN_LEASE_WINDOW_MS / 3);
/**
 * How long the slow-link case watches for an extra beat after the second one lands. Two assumed
 * cadences: a loop that budgets a beat at its cadence re-sends every one of them and is caught
 * inside this window, while the correct loop has moved to a third of the 30s window by then and is
 * quiet until ten seconds in. Sampling on arrivals plus a quiet window — rather than a fixed wall
 * clock — keeps a runner stall from reading as a missing beat.
 */
const SLOW_BEAT_QUIET_WINDOW_MS = ASSUMED_BEAT_INTERVAL_MS * 2;

/**
 * How the fake daemon makes the upload the long phase it is.
 *
 * - `renewed`: withhold the artifact until a second beat has renewed the lease mid-upload.
 * - `lost`: stop the artifact in flight and have the second beat report the lease gone.
 * - `slow`: answer every beat late, which is what tells a budget sized to the window from one sized
 *   to the cadence.
 */
type UploadMode = 'renewed' | 'lost' | 'slow';

/**
 * #2946's route end to end: `sendToDaemon` uploads an artifact for a remote install before the
 * install request is admitted, and the beat is what keeps the lease alive across that gap. The unit
 * suite covers the beat loop, the request a beat sends, and the upload client each in isolation;
 * none of them would notice the wiring between the three being dropped.
 */

type FakeDaemon = Readonly<{
  baseUrl: string;
  /** Beats and commands the daemon saw, in arrival order. */
  seen: readonly string[];
  /** Bytes of the artifact the daemon actually read. */
  uploadBytes(): number;
  /** When each beat reached the daemon, as `process.hrtime.bigint()` readings. */
  readonly beatArrivals: readonly bigint[];
  /**
   * Stops withholding the artifact and reports how the upload ended. The caller releases it after
   * `sendToDaemon` settles, so the answer is causal rather than timed: an upload the client did not
   * cancel has nothing left that could stop it by then, and one it did cannot arrive.
   */
  releaseUpload(graceMs?: number): Promise<'drained' | 'canceled' | 'unresolved'>;
  /**
   * Stops withholding the artifact without waiting for it. Fails when no upload reached this daemon,
   * so a caller that expected one learns that now instead of awaiting a response that never comes.
   */
  resumeUpload(): void;
  close(): Promise<void>;
}>;

/**
 * A remote daemon that answers a beat and treats the upload as the long phase it is.
 *
 * `stallUpload` decides how the artifact is held: withheld while it drains until a second beat has
 * landed, or stopped in flight after the first chunk. Without that hold, "the lease was renewed
 * during the upload" would be a race the test happens to win rather than something it establishes.
 */
async function startFakeRemoteDaemon(mode: UploadMode): Promise<FakeDaemon> {
  const seen: string[] = [];
  let uploadBytes = 0;
  let beatsAnswered = 0;
  const beatArrivals: bigint[] = [];
  let leaseDeclaredLost = false;
  let releaseWithheldUpload: (() => void) | undefined;
  let resolveOutcome!: (outcome: 'drained' | 'canceled') => void;
  const outcome = new Promise<'drained' | 'canceled'>((resolve) => {
    resolveOutcome = resolve;
  });

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').startsWith('/health')) {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.url === '/upload/preflight') {
      // Drained before the 404, so the fallback to the legacy upload route is the protocol's doing
      // and not a matter of socket recycling.
      readJsonBody(req, () => {
        res.writeHead(404);
        res.end('not found');
      });
      return;
    }
    if (req.url === '/upload') {
      handleUpload(req, res);
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    readJsonBody(req, (payload) => {
      if (payload.method === 'agent_device.lease.heartbeat') {
        answerBeat(res, payload);
        return;
      }
      seen.push(String(payload.params?.command ?? payload.method));
      writeJson(res, 200, {
        jsonrpc: '2.0',
        id: payload.id,
        result: { ok: true, data: { package: 'com.example.demo' } },
      });
    });
  });

  function handleUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    let answered = false;
    let bodyArrived = false;
    let stalled = false;
    // The slow-link case holds the artifact against one beat: a beat answering there only proves the
    // lease was renewed, and must not also be what ends the phase being measured.
    const holdUntilBeats = mode === 'slow' ? 1 : 2;
    // The artifact's response is withheld until a beat has renewed the lease mid-upload, so the
    // first case proves the renewal landed while the install was still in flight. A beat that
    // reports the lease gone must not also complete the upload it exists to stop: that artifact's
    // fate belongs to the abort, not to a response from here.
    const answerUpload = (): void => {
      if (answered || !bodyArrived || leaseDeclaredLost) return;
      if (beatsAnswered < holdUntilBeats) return;
      answered = true;
      writeJson(res, 200, { ok: true, uploadId: 'upload-demo.apk' });
    };
    releaseWithheldUpload = () => {
      if (stalled) req.resume();
      answerUpload();
    };
    req.on('data', (chunk: Buffer) => {
      uploadBytes += chunk.length;
      // Pausing once, not per chunk: releasing the pressure has to let the artifact through, or a
      // stalled upload and a canceled one are the same observation from here.
      if (!stalled) {
        req.pause();
        stalled = true;
      }
    });
    req.on('end', () => {
      bodyArrived = true;
      resolveOutcome('drained');
      answerUpload();
    });
    req.on('aborted', () => {
      if (!answered) resolveOutcome('canceled');
    });
    res.on('close', () => {
      if (!answered) resolveOutcome('canceled');
    });
  }

  function answerBeat(res: http.ServerResponse, payload: RpcPayload): void {
    beatsAnswered += 1;
    beatArrivals.push(process.hrtime.bigint());
    seen.push('lease_heartbeat');
    assert.equal(payload.params?.leaseId, LEASE_ID, 'a beat names the lease it protects');
    // Only a beat after the first can say anything about the upload: the loop fires one at t=0,
    // while the artifact is still being hashed.
    if (mode === 'lost' && beatsAnswered >= 2) {
      leaseDeclaredLost = true;
      writeLeaseLostError(res, payload.id);
      return;
    }
    const windowMs = mode === 'slow' ? SLOW_BEAT_LEASE_WINDOW_MS : LEASE_WINDOW_MS;
    writeBeatAnswer(res, payload.id, windowMs);
    if (mode !== 'slow') releaseWithheldUpload?.();
  }

  function writeBeatAnswer(res: http.ServerResponse, id: unknown, windowMs: number): void {
    const answer = (): void => {
      const now = Date.now();
      writeJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: { ok: true, data: { lease: { heartbeatAt: now, expiresAt: now + windowMs } } },
      });
    };
    if (mode !== 'slow') {
      answer();
      return;
    }
    setTimeout(answer, SLOW_BEAT_MS).unref();
  }
  server.keepAliveTimeout = 100;

  const port = await listenOnLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    seen,
    uploadBytes: () => uploadBytes,
    beatArrivals,
    async releaseUpload(graceMs = 2_000) {
      releaseWithheldUpload?.();
      return await Promise.race([
        outcome,
        new Promise<'unresolved'>((resolve) => {
          setTimeout(() => resolve('unresolved'), graceMs).unref();
        }),
      ]);
    },
    resumeUpload() {
      if (releaseWithheldUpload === undefined) {
        throw new Error('no artifact ever reached this daemon, so nothing was being withheld');
      }
      releaseWithheldUpload();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

type RpcPayload = Readonly<{ id: unknown; method: string; params?: Record<string, unknown> }>;

function readJsonBody(req: http.IncomingMessage, done: (payload: RpcPayload) => void): void {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    done(JSON.parse(body) as RpcPayload);
  });
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function writeLeaseLostError(res: http.ServerResponse, id: unknown): void {
  writeJson(res, 400, {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: 'Lease is not active',
      data: {
        code: 'UNAUTHORIZED',
        message: 'Lease is not active',
        details: { reason: 'LEASE_NOT_FOUND' },
      },
    },
  });
}

/** An install of `apkPath` against a remote daemon, under the lease the beat has to renew. */
function installRequest(baseUrl: string, apkPath: string): Omit<DaemonRequest, 'token'> {
  return {
    session: 'upload-beat',
    command: 'install',
    positionals: [apkPath],
    flags: {
      platform: 'android',
      daemonBaseUrl: baseUrl,
      stateDir: path.dirname(apkPath),
      leaseId: LEASE_ID,
      tenant: 'acme',
      runId: 'run-1',
      leaseProvider: 'proxy',
      deviceKey: 'android:mobile:emulator-5554',
      clientId: 'client-a',
    },
    meta: { cwd: path.dirname(apkPath) },
  };
}

const TRANSPORT = { authToken: TOKEN } as const;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * How many beats arrived, once the loop has been seen to go quiet.
 *
 * Waits for `expected` arrivals, then keeps watching through one quiet window and returns the count.
 * A loop that keeps beating at the cadence it assumed is still arriving inside that window, so it is
 * counted rather than awaited; a loop that moved to the window it just renewed is silent through it.
 * Settling on arrivals instead of a fixed wall clock means a runner stall delays the sample instead
 * of dropping a beat from it. The deadline bounds the wait so a beat that never comes fails on that
 * fact rather than on the lane's timeout.
 */
async function settleBeatArrivals(daemon: FakeDaemon, expected: number): Promise<number> {
  const deadline = Date.now() + ASSUMED_BEAT_INTERVAL_MS * 3;
  while (daemon.beatArrivals.length < expected) {
    if (Date.now() > deadline) {
      throw new Error(
        `only ${String(daemon.beatArrivals.length)} of ${String(expected)} beats arrived; ` +
          `daemon saw: ${daemon.seen.join(', ') || 'nothing'}`,
      );
    }
    await sleep(25);
  }
  await sleep(SLOW_BEAT_QUIET_WINDOW_MS);
  return daemon.beatArrivals.length;
}

async function withUploadedArtifact<R>(
  t: { skip(reason?: string): void },
  mode: UploadMode,
  run: (daemon: FakeDaemon, apkPath: string) => Promise<R>,
): Promise<R | undefined> {
  if (await skipWhenLoopbackUnavailable(t)) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-upload-beat-'));
  const apkPath = path.join(dir, 'demo.apk');
  fs.writeFileSync(apkPath, Buffer.alloc(APK_BYTES, 'x'));
  const daemon = await startFakeRemoteDaemon(mode);
  try {
    return await run(daemon, apkPath);
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an install beats the lease while its artifact uploads, before the install RPC', async (t) => {
  await withUploadedArtifact(t, 'renewed', async (daemon, apkPath) => {
    const response = await sendToDaemon(installRequest(daemon.baseUrl, apkPath), TRANSPORT);

    assert.equal(response.ok, true);
    assert.equal(daemon.uploadBytes(), APK_BYTES, 'the artifact arrived whole');
    // The response was withheld until the second beat, so that beat proves the lease was renewed
    // while the install was still mid-flight.
    assert.deepEqual(daemon.seen, ['lease_heartbeat', 'lease_heartbeat', 'install']);
  });
});

test('a lease lost mid-upload aborts the upload and no install request goes out', async (t) => {
  await withUploadedArtifact(t, 'lost', async (daemon, apkPath) => {
    await assert.rejects(
      async () => await sendToDaemon(installRequest(daemon.baseUrl, apkPath), TRANSPORT),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'UNAUTHORIZED' &&
        error.details?.reason === 'LEASE_NOT_FOUND',
    );

    assert.ok(daemon.uploadBytes() < APK_BYTES, 'the artifact stopped short of the end');
    assert.equal(
      await daemon.releaseUpload(),
      'canceled',
      'the request was destroyed, not left to finish on a lease nobody held',
    );
    assert.ok(
      !daemon.seen.includes('install'),
      `nothing was asked of a device no longer ours, daemon saw: ${daemon.seen.join(', ')}`,
    );
  });
});

test(
  'a beat that takes over a second to answer sets the cadence instead of timing out',
  async (t) => {
    await withUploadedArtifact(t, 'slow', async (daemon, apkPath) => {
      let timeoutsDuringUpload = -1;
      let beatsDuringUpload = -1;
      let response: Awaited<ReturnType<typeof sendToDaemon>> | undefined;

      // The request has to run inside a diagnostics scope for the absence of a timeout to mean
      // anything: outside one, `emitDiagnostic` records nothing at all and every count reads zero.
      await withDiagnosticsScope({ session: 'upload-beat', command: 'install' }, async () => {
        const running = sendToDaemon(installRequest(daemon.baseUrl, apkPath), TRANSPORT);
        // Two beats, not three: the opening one, and the successor the loop had already armed at
        // the cadence it assumes before any window is known. The first beat's late answer then
        // moves the loop to a third of the 30s window it just renewed, so nothing else is due for
        // ten seconds. A beat budgeted at its cadence is cut off before that answer lands, never
        // learns the window, and keeps arriving every assumed cadence with a `daemon_request_timeout`
        // behind it — which is #2946's slow link wearing the beat down instead of protecting it.
        // The count settles on arrivals going quiet rather than on a wall-clock sample, so a loaded
        // runner delays the read instead of moving a beat across it.
        beatsDuringUpload = await settleBeatArrivals(daemon, 2);
        timeoutsDuringUpload = countDiagnosticEventsByPhase(['daemon_request_timeout']);
        // Only now does the artifact get the rest of its way in, so everything above was measured
        // while the upload was genuinely still running.
        daemon.resumeUpload();
        response = await running;
      });

      assert.equal(response!.ok, true);
      assert.equal(beatsDuringUpload, 2, `beats seen: ${String(beatsDuringUpload)}`);
      assert.equal(
        timeoutsDuringUpload,
        0,
        'a heartbeat the transport cut off is a timeout, not a slow answer',
      );

      assert.deepEqual(daemon.seen, ['lease_heartbeat', 'lease_heartbeat', 'install']);
    });
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);
