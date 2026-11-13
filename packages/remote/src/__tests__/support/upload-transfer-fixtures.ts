// Shared support for the tests that put real budget pressure on a real artifact upload (#4441).
//
// Every helper here exists so a test can spend minutes of transfer budget without waiting for them:
// the daemon holds the request body open chunk by chunk and the test drives the clock. The socket,
// the framing and the client's own stream stay real, which is the point — a mocked transport cannot
// prove that a transfer which keeps moving is never cut short, nor that one which stops is.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { vi } from 'vitest';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { uploadArtifact } from '../../upload-client.ts';

export const PREFLIGHT_REQUEST = 'POST /upload/preflight';
export const LEGACY_UPLOAD_REQUEST = 'POST /upload';

/** Budget step used when a test just needs time to pass: fine enough that no phase boundary is
 * stepped over, cheap enough that six minutes of budget stay a few hundred loop turns. */
const BUDGET_STEP_MS = 5_000;

export type UploadOutcome = { value: string | undefined; error: unknown };

/** An upload whose completion can be observed without awaiting it, which a controlled clock needs. */
export type SettledUpload = Promise<UploadOutcome> & { settled: boolean };

/** Starts the clock every transfer budget in these tests is measured against. */
export function useTransferClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

export function startUpload(options: {
  baseUrl: string;
  artifactPath: string;
  signal?: AbortSignal;
}): SettledUpload {
  let settled = false;
  const upload = uploadArtifact({
    env: process.env,
    localPath: options.artifactPath,
    baseUrl: options.baseUrl,
    token: 'daemon-token',
    ...(options.signal ? { signal: options.signal } : {}),
  }).then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as string | undefined, error }),
  ) as SettledUpload;
  void upload.then(() => {
    settled = true;
  });
  Object.defineProperty(upload, 'settled', { get: () => settled });
  return upload;
}

/**
 * Advances the controlled clock while letting real socket work run between the steps, until `ready`
 * holds or the transfer is over.
 *
 * Body progress re-arms an inactivity budget, so a stalled transfer is cut off only once the steps
 * stop being interrupted by bytes — exactly the condition under test. A settled transfer ends the
 * wait: a budget that fired is an answer, not a reason to keep ticking.
 */
async function spendUntil(options: {
  ready: () => boolean;
  maxMs: number;
  settled?: () => boolean;
}): Promise<boolean> {
  const { ready, maxMs, settled } = options;
  for (let elapsed = 0; elapsed < maxMs; elapsed += BUDGET_STEP_MS) {
    await vi.advanceTimersByTimeAsync(BUDGET_STEP_MS);
    await pumpRealWork();
    if (ready()) return true;
    if (settled?.()) return ready();
  }
  return ready();
}

/** Spends `ms` of budget in `BUDGET_STEP_MS` steps without letting a single byte through. */
export async function spendBudget(ms: number, upload: SettledUpload): Promise<void> {
  await spendUntil({ ready: () => false, maxMs: ms, settled: () => upload.settled });
}

/**
 * Spends `windows` windows of `windowMs` each while the body keeps moving.
 *
 * Each window hands back what the daemon had parked and is then charged to the transfer, so the only
 * way it can be paid for is by bytes arriving: a window in which `receivedBytes` did not grow is a
 * window the transfer did not earn, and the result says so. Progress is judged only once bytes have
 * started moving; getting there costs the socket buffers, not the transfer.
 */
export async function spendProgressWindows(
  daemon: ParkedUploadDaemon,
  upload: SettledUpload,
  options: { windows: number; windowMs: number },
): Promise<{ progressedInEveryWindow: boolean; budgetMs: number }> {
  await spendUntil({ ready: () => daemon.receivedBytes > 0, maxMs: 60_000 });
  let progressedInEveryWindow = true;
  let spent = 0;
  for (let window = 0; window < options.windows; window += 1) {
    const bytesBeforeWindow = daemon.receivedBytes;
    daemon.releaseAllParked();
    await vi.advanceTimersByTimeAsync(options.windowMs);
    spent += options.windowMs;
    await pumpRealWork();
    if (upload.settled) break;
    if (daemon.receivedBytes <= bytesBeforeWindow) progressedInEveryWindow = false;
  }
  return { progressedInEveryWindow, budgetMs: spent };
}

/**
 * Hands over the last few timer ticks a settled transfer needs to tear its leg down.
 *
 * A phase budget that expires aborts the request, and that abort reaches the client through the
 * socket's own close path, which needs turns of both the controlled clock and the real loop before
 * the upload promise rejects.
 */
export async function settleAfterBudget(upload: SettledUpload): Promise<void> {
  for (let round = 0; round < 200 && !upload.settled; round += 1) {
    await vi.advanceTimersByTimeAsync(100);
    await pumpRealWork(5);
  }
}

/**
 * Lets real socket work finish without spending budget.
 *
 * A destroyed connection reports its close on a later turn of the real event loop, so a test that
 * asserts a leg was torn down has to let that turn run.
 */
export async function pumpRealWork(rounds = 40): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Writes an artifact of exactly `bytes`, so a test can size a body against a release cadence. */
export function createArtifactFile(bytes: number, fileName = 'app.apk'): string {
  const dir = mkdtempForTestSync('agent-device-upload-phases-');
  const artifactPath = path.join(dir, fileName);
  fs.writeFileSync(artifactPath, Buffer.alloc(bytes, 'x'));
  return artifactPath;
}

export type ParkedUploadDaemon = {
  readonly baseUrl: string;
  readonly requests: readonly string[];
  /** Bytes the daemon has accepted for the upload leg. */
  readonly receivedBytes: number;
  /** Lets every chunk the daemon has parked so far through. */
  releaseAllParked(): void;
  close(): Promise<void>;
};

/**
 * A loopback daemon that accepts an artifact upload and parks its body chunk by chunk, never
 * answering the leg.
 *
 * The body is parked so a transfer can be held open long enough to spend a budget while putting real
 * backpressure on the writing side. Preflight is refused, so the upload runs on the legacy POST
 * route: the one path that pipes a file at the daemon and keeps going while the daemon drains it.
 */
export async function startParkedUploadDaemon(): Promise<ParkedUploadDaemon> {
  const requests: string[] = [];
  const parked: http.IncomingMessage[] = [];
  let receivedBytes = 0;

  const server = http.createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    requests.push(key);
    if (key === PREFLIGHT_REQUEST) {
      req.resume();
      req.on('end', () => {
        res.statusCode = 404;
        res.end('not found');
      });
      return;
    }
    if (key === LEGACY_UPLOAD_REQUEST) {
      req.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        req.pause();
        parked.push(req);
      });
      return;
    }
    req.resume();
    req.on('end', () => {
      res.statusCode = 500;
      res.end('only the upload leg the test set up is expected');
    });
  });
  // The clock under test is controlled, so the daemon's own idle and request ceilings must not join
  // the race: they would fire on the fake clock and destroy a leg the client is still progressing.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.unref();
  const port = await listenOnLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get receivedBytes() {
      return receivedBytes;
    },
    releaseAllParked() {
      for (const entry of parked.splice(0)) entry.resume();
    },
    close: () => closeLoopbackServer(server),
  };
}

export function assertDetailedError(
  error: unknown,
  details: Record<string, unknown>,
): asserts error is { details?: Record<string, unknown> } {
  assert.ok(error && typeof error === 'object', `expected an error, got ${String(error)}`);
  const actual = JSON.stringify((error as { details?: unknown }).details ?? {});
  for (const [key, value] of Object.entries(details)) {
    assert.equal(
      (error as { details?: Record<string, unknown> }).details?.[key],
      value,
      `${key} of ${actual}`,
    );
  }
}
