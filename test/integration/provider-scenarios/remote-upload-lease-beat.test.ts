import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { sendToDaemon } from '../../../src/daemon-client/daemon-client.ts';
import type { DaemonRequest } from '../../../src/daemon/daemon-request.ts';
import {
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';

const LEASE_ID = 'lease-upload-beat';
const TOKEN = 'upload-beat-token';
const APK_BYTES = 4 * 1024 * 1024;
/** Renewed window the fake daemon reports; a third of it is the cadence the client beats on. */
const LEASE_WINDOW_MS = 3_000;

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
  /**
   * Stops withholding the artifact and reports how the upload ended. The caller releases it after
   * `sendToDaemon` settles, so the answer is causal rather than timed: an upload the client did not
   * cancel has nothing left that could stop it by then, and one it did cannot arrive.
   */
  releaseUpload(graceMs?: number): Promise<'drained' | 'canceled' | 'unresolved'>;
  close(): Promise<void>;
}>;

/**
 * A remote daemon that answers a beat and treats the upload as the long phase it is.
 *
 * `stallUpload` decides how the artifact is held: withheld while it drains until a second beat has
 * landed, or stopped in flight after the first chunk. Without that hold, "the lease was renewed
 * during the upload" would be a race the test happens to win rather than something it establishes.
 */
async function startFakeRemoteDaemon(stallUpload: boolean): Promise<FakeDaemon> {
  const seen: string[] = [];
  let uploadBytes = 0;
  let beatsAnswered = 0;
  let leaseDeclaredLost = false;
  let resumeUpload: (() => void) | undefined;
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
    // The artifact's response is withheld until a beat has renewed the lease mid-upload, so the
    // first case proves the renewal landed while the install was still in flight. A beat that
    // reports the lease gone must not also complete the upload it exists to stop: that artifact's
    // fate belongs to the abort, not to a response from here.
    const answerUpload = (): void => {
      if (answered || !bodyArrived || leaseDeclaredLost || beatsAnswered < 2) return;
      answered = true;
      writeJson(res, 200, { ok: true, uploadId: 'upload-demo.apk' });
    };
    resumeUpload = () => {
      if (stalled) req.resume();
      answerUpload();
    };
    req.on('data', (chunk: Buffer) => {
      uploadBytes += chunk.length;
      // Pausing once, not per chunk: releasing the pressure has to let the artifact through, or a
      // stalled upload and a canceled one are the same observation from here.
      if (stallUpload && !stalled) {
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
    seen.push('lease_heartbeat');
    assert.equal(payload.params?.leaseId, LEASE_ID, 'a beat names the lease it protects');
    // Only a beat after the first can say anything about the upload: the loop fires one at t=0,
    // while the artifact is still being hashed.
    if (stallUpload && beatsAnswered >= 2) {
      leaseDeclaredLost = true;
      writeLeaseLostError(res, payload.id);
      return;
    }
    const now = Date.now();
    writeJson(res, 200, {
      jsonrpc: '2.0',
      id: payload.id,
      result: { ok: true, data: { lease: { heartbeatAt: now, expiresAt: now + LEASE_WINDOW_MS } } },
    });
    resumeUpload?.();
  }
  server.keepAliveTimeout = 100;

  const port = await listenOnLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    seen,
    uploadBytes: () => uploadBytes,
    async releaseUpload(graceMs = 2_000) {
      resumeUpload?.();
      return await Promise.race([
        outcome,
        new Promise<'unresolved'>((resolve) => {
          setTimeout(() => resolve('unresolved'), graceMs).unref();
        }),
      ]);
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

async function withUploadedArtifact<R>(
  t: { skip(reason?: string): void },
  stallUpload: boolean,
  run: (daemon: FakeDaemon, apkPath: string) => Promise<R>,
): Promise<R | undefined> {
  if (await skipWhenLoopbackUnavailable(t)) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-upload-beat-'));
  const apkPath = path.join(dir, 'demo.apk');
  fs.writeFileSync(apkPath, Buffer.alloc(APK_BYTES, 'x'));
  const daemon = await startFakeRemoteDaemon(stallUpload);
  try {
    return await run(daemon, apkPath);
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an install beats the lease while its artifact uploads, before the install RPC', async (t) => {
  await withUploadedArtifact(t, false, async (daemon, apkPath) => {
    const response = await sendToDaemon(installRequest(daemon.baseUrl, apkPath), TRANSPORT);

    assert.equal(response.ok, true);
    assert.equal(daemon.uploadBytes(), APK_BYTES, 'the artifact arrived whole');
    // The response was withheld until the second beat, so that beat proves the lease was renewed
    // while the install was still mid-flight.
    assert.deepEqual(daemon.seen, ['lease_heartbeat', 'lease_heartbeat', 'install']);
  });
});

test('a lease lost mid-upload aborts the upload and no install request goes out', async (t) => {
  await withUploadedArtifact(t, true, async (daemon, apkPath) => {
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
