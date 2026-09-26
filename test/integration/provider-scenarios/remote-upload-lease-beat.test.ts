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
/** How long a stalled upload gets to observe its own cancellation before the daemon drains it. */
const CANCEL_NOTICE_MS = 150;

/**
 * #2946's route end to end: `sendToDaemon` uploads an artifact for a remote install before the
 * install request is admitted, and the beat is what keeps the lease alive across that gap. The unit
 * suite covers the beat loop, the request a beat sends, and the upload client each in isolation;
 * none of them would notice the wiring between the three being dropped.
 */

type FakeDaemon = {
  baseUrl: string;
  /** Beats and commands the daemon saw, in arrival order. */
  seen: string[];
  uploadBytesDelivered(): number;
  /**
   * How the upload ended, as the daemon observed it: the artifact drained, or the request carrying
   * it was destroyed. Waits for the first of the two, because neither is instantaneous.
   */
  uploadOutcome(graceMs?: number): Promise<'drained' | 'canceled' | 'unresolved'>;
  close(): Promise<void>;
};

type UploadBehaviour = 'complete' | 'backpressure';

/**
 * A remote daemon that only answers a beat, and treats the upload as the long phase it is:
 *
 * - `complete` drains the artifact and withholds the upload response until a second beat has
 *   arrived, so "the lease was renewed while the artifact was still uploading" is a fact of the
 *   test rather than a race it happens to win.
 * - `backpressure` stops reading after the first chunk, so the artifact is still in flight when the
 *   next beat reports the lease gone — the state the abort exists for.
 */
async function startFakeRemoteDaemon(behaviour: UploadBehaviour): Promise<FakeDaemon> {
  const seen: string[] = [];
  let uploadBytesDelivered = 0;
  let resolveOutcome!: (outcome: 'drained' | 'canceled') => void;
  const settled = new Promise<'drained' | 'canceled'>((resolve) => {
    resolveOutcome = resolve;
  });
  let stopBackpressure: (() => void) | undefined;
  let beatsAnswered = 0;
  let leaseDeclaredLost = false;
  let writeUploadResponse: (() => void) | undefined;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').startsWith('/health')) {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (req.url === '/upload/preflight') {
      // Draining before the 404 keeps the connection usable; an early end would make the client's
      // fallback to the legacy upload route a matter of socket recycling rather than the protocol.
      readJsonBody(req, () => {
        res.writeHead(404);
        res.end('not found');
      });
      return;
    }
    if (req.url === '/upload') {
      handleUpload(req, res, behaviour, {
        onBytes: (length) => {
          uploadBytesDelivered += length;
        },
        onBodyArrived: () => {
          resolveOutcome('drained');
        },
        onCanceled: () => {
          resolveOutcome('canceled');
        },
        holdResponse: (write) => {
          writeUploadResponse = write;
          if (!leaseDeclaredLost && beatsAnswered >= 2) write();
        },
        releaseBackpressure: (resume) => {
          stopBackpressure = resume;
        },
      });
      return;
    }
    if (req.url !== '/rpc') {
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

  function answerBeat(res: http.ServerResponse, payload: RpcPayload): void {
    beatsAnswered += 1;
    seen.push('lease_heartbeat');
    assert.equal(payload.params?.leaseId, LEASE_ID, 'a beat names the lease it protects');
    // Only a beat after the first can say anything about the upload: the loop fires one at t=0,
    // while the artifact is still being hashed.
    const leaseGone = behaviour === 'backpressure' && beatsAnswered >= 2;
    if (leaseGone) {
      leaseDeclaredLost = true;
      // A writer stalled on backpressure and a writer that was just canceled look identical from
      // here, so the daemon releases the pressure and lets the difference show: the canceled
      // request is already destroyed and stops short, while one nobody canceled drains. Deferring
      // it is what keeps that a causal gap rather than a race for the same tick.
      setTimeout(() => stopBackpressure?.(), CANCEL_NOTICE_MS).unref();
      writeLeaseLostError(res, payload.id);
      // A beat that reports the lease gone must not also complete the upload it is meant to stop:
      // the artifact's fate is decided by the abort, not by a response from here.
      return;
    }
    const now = Date.now();
    writeJson(res, 200, {
      jsonrpc: '2.0',
      id: payload.id,
      result: { ok: true, data: { lease: { heartbeatAt: now, expiresAt: now + LEASE_WINDOW_MS } } },
    });
    writeUploadResponse?.();
  }
  server.keepAliveTimeout = 100;

  const port = await listenOnLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    seen,
    uploadBytesDelivered: () => uploadBytesDelivered,
    async uploadOutcome(graceMs = 1_000) {
      return await Promise.race([
        settled,
        new Promise<'unresolved'>((resolve) => {
          setTimeout(() => resolve('unresolved'), graceMs).unref();
        }),
      ]);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  behaviour: UploadBehaviour,
  hooks: Readonly<{
    onBytes(length: number): void;
    onBodyArrived(): void;
    onCanceled(): void;
    holdResponse(write: () => void): void;
    releaseBackpressure(resume: () => void): void;
  }>,
): void {
  let answered = false;
  const respond = (): void => {
    if (answered) return;
    answered = true;
    writeJson(res, 200, { ok: true, uploadId: 'upload-demo.apk' });
  };
  const requestSettled = (): void => {
    if (answered) return;
    hooks.onCanceled();
  };
  req.on('aborted', requestSettled);
  res.on('close', requestSettled);
  let stalled = false;
  req.on('data', (chunk: Buffer) => {
    hooks.onBytes(chunk.length);
    // Stopping the read applies backpressure, so the artifact stays in flight instead of racing
    // through loopback and making "stopped early" a matter of timing.
    // Pausing once, rather than on every chunk: releasing the pressure has to actually let the
    // artifact through, otherwise a stalled upload and a canceled one are the same observation.
    if (behaviour === 'backpressure' && !stalled) {
      req.pause();
      stalled = true;
    }
  });
  req.on('end', () => {
    hooks.onBodyArrived();
    hooks.holdResponse(respond);
  });
  hooks.releaseBackpressure(() => {
    if (stalled) req.resume();
  });
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

function installRequest(
  baseUrl: string,
  apkPath: string,
  stateDir: string,
): Omit<DaemonRequest, 'token'> {
  return {
    session: 'upload-beat',
    command: 'install',
    positionals: [apkPath],
    flags: {
      platform: 'android',
      daemonBaseUrl: baseUrl,
      stateDir,
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

async function withUploadFixture<R>(
  t: { skip(reason?: string): void },
  behaviour: UploadBehaviour,
  run: (daemon: FakeDaemon, apkPath: string) => Promise<R>,
): Promise<R | undefined> {
  if (await skipWhenLoopbackUnavailable(t)) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-upload-beat-'));
  const apkPath = path.join(dir, 'demo.apk');
  fs.writeFileSync(apkPath, Buffer.alloc(APK_BYTES, 'x'));
  const daemon = await startFakeRemoteDaemon(behaviour);
  try {
    return await run(daemon, apkPath);
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an install beats the lease while its artifact uploads, before the install RPC', async (t) => {
  await withUploadFixture(t, 'complete', async (daemon, apkPath) => {
    const response = await sendToDaemon(
      installRequest(daemon.baseUrl, apkPath, path.dirname(apkPath)),
      TRANSPORT,
    );

    assert.equal(response.ok, true);
    assert.ok(
      daemon.seen.filter((entry) => entry === 'lease_heartbeat').length >= 2,
      `a beat has to land while the upload is held open, daemon saw: ${daemon.seen.join(', ')}`,
    );
    assert.equal(
      await daemon.uploadOutcome(),
      'drained',
      'the artifact arrived whole on a lease that was being renewed under it',
    );
    assert.deepEqual(daemon.seen, ['lease_heartbeat', 'lease_heartbeat', 'install']);
  });
});

test('a lease lost mid-upload aborts the upload and no install request goes out', async (t) => {
  await withUploadFixture(t, 'backpressure', async (daemon, apkPath) => {
    await assert.rejects(
      async () =>
        await sendToDaemon(
          installRequest(daemon.baseUrl, apkPath, path.dirname(apkPath)),
          TRANSPORT,
        ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'UNAUTHORIZED' &&
        error.details?.reason === 'LEASE_NOT_FOUND',
    );

    assert.ok(
      daemon.uploadBytesDelivered() > 0,
      'bytes were already in flight, which is what had to be stopped',
    );
    // The daemon released its backpressure after the beat that lost the lease, so an upload nobody
    // canceled would have drained to the end. A destroyed request is the only other way this ends.
    assert.equal(
      await daemon.uploadOutcome(),
      'canceled',
      'the upload was stopped, not left to finish on a lease nobody held',
    );
    assert.ok(
      !daemon.seen.includes('install'),
      `nothing was asked of a device no longer ours, daemon saw: ${daemon.seen.join(', ')}`,
    );
  });
});
