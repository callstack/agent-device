// Shared support for the tests that put real budget pressure on a real artifact upload (#4441).
//
// Every helper here exists so a test can spend minutes of transfer budget without waiting for them:
// the daemon holds the request body open chunk by chunk and the test drives the clock. The socket,
// the framing and the client's own stream stay real, which is the point — a mocked transport cannot
// prove that a transfer which keeps moving is never cut short, nor that one which stops is, nor
// where an owned pipeline was still writing when an attempt ended.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { vi } from 'vitest';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { uploadArtifact } from '../../upload-client.ts';
import { type UploadStreamResponse, streamFileToHttpRequest } from '../../upload-stream.ts';

export const PREFLIGHT_REQUEST = 'POST /upload/preflight';
export const LEGACY_UPLOAD_REQUEST = 'POST /upload';

/** Budget step used when a test just needs time to pass: fine enough that no phase boundary is
 * stepped over, cheap enough that six minutes of budget stay a few hundred loop turns. */
const BUDGET_STEP_MS = 5_000;

/** Ceiling on what the parked daemon takes between two progress windows. Small enough that an
 * artifact sized in megabytes cannot be drained by the windows a test runs, and large enough that
 * one release always moves real bytes over the socket. */
const RELEASE_QUOTA_BYTES = 256 * 1024;

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

/** The outcome of one `startUploadAttempt`, observable without awaiting it. */
export type UploadAttemptOutcome = {
  value: UploadStreamResponse | undefined;
  error: unknown;
};
export type SettledUploadAttempt = Promise<UploadAttemptOutcome> & { settled: boolean };

/**
 * One upload attempt straight at `url`, with its outcome observed rather than awaited.
 *
 * The attempt-level lifecycle — an early answer, the join that has to follow it, the phase that
 * expires — belongs to `streamFileToHttpRequest`, so the tests that prove it drive that seam
 * directly instead of routing a whole upload client around it.
 */
export function startUploadAttempt(options: {
  url: string;
  artifactPath: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): SettledUploadAttempt {
  let settled = false;
  const attempt = streamFileToHttpRequest({
    url: new URL(options.url),
    method: options.method ?? 'POST',
    headers: options.headers ?? { authorization: 'Bearer daemon-token' },
    payloadPath: options.artifactPath,
    timeoutMessage: 'Artifact upload timed out',
    errorMessage: 'Failed to upload artifact to remote daemon',
    ...(options.signal ? { signal: options.signal } : {}),
  }).then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as UploadStreamResponse | undefined, error }),
  ) as SettledUploadAttempt;
  void attempt.then(() => {
    settled = true;
  });
  Object.defineProperty(attempt, 'settled', { get: () => settled });
  return attempt;
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

/** Spends `ms` of budget in `BUDGET_STEP_MS` steps against a single attempt. */
export async function spendAttemptBudget(ms: number, attempt: SettledUploadAttempt): Promise<void> {
  await spendUntil({ ready: () => false, maxMs: ms, settled: () => attempt.settled });
}

/**
 * Spends `windows` windows of `windowMs` each while the body keeps moving.
 *
 * Each window releases one quota of the parked body, waits with real event-loop turns until the peer
 * really took more bytes, and only then charges `windowMs` to the transfer. Waiting before charging
 * is what makes a window mean something: bytes cross the socket only while the real loop runs, so a
 * window charged before they arrive measures the host's scheduling, not the transfer. Once the peer
 * has taken the whole body the transfer has nothing left to move and only a response is owed, so
 * later windows add budget without a growth requirement.
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
    const bodyInFlight = !daemon.bodyEnded;
    const bytesBeforeWindow = daemon.receivedBytes;
    daemon.releaseAllParked();
    // With the body fully taken there is nothing left to move and only a response is owed, so the
    // window is charged without a growth requirement.
    const grew = bodyInFlight ? await awaitBytesGrowth(daemon, bytesBeforeWindow) : true;
    await vi.advanceTimersByTimeAsync(options.windowMs);
    spent += options.windowMs;
    if (upload.settled) break;
    if (!grew) progressedInEveryWindow = false;
  }
  return { progressedInEveryWindow, budgetMs: spent };
}

/** Lets the real loop run until the peer has taken at least one more byte of the parked body. */
async function awaitBytesGrowth(daemon: ParkedUploadDaemon, bytesBefore: number): Promise<boolean> {
  for (let round = 0; round < 400; round += 1) {
    if (daemon.receivedBytes > bytesBefore) return true;
    daemon.releaseAllParked();
    await pumpRealWork(15);
  }
  return daemon.receivedBytes > bytesBefore;
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
 * Hands over the last few timer ticks a settled attempt needs to tear its leg down, and reports the
 * real-time ticks it cost.
 *
 * A join that waits on a peer is the bug these tests look for, so a test that has to settle an
 * attempt gets a number it can bound rather than a pass that says nothing about cost.
 */
export async function settleAttemptAfterBudget(
  attempt: SettledUploadAttempt,
  options: { maxRounds?: number } = {},
): Promise<{ rounds: number; settled: boolean }> {
  const maxRounds = options.maxRounds ?? 200;
  let rounds = 0;
  for (; rounds < maxRounds && !attempt.settled; rounds += 1) {
    await vi.advanceTimersByTimeAsync(100);
    await pumpRealWork(5);
  }
  return { rounds, settled: attempt.settled };
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

/**
 * A loopback daemon that accepts an artifact upload and parks its body a quota at a time, never
 * answering the leg.
 *
 * The body is parked so a transfer can be held open long enough to spend a budget while putting real
 * backpressure on the writing side. Each release lets one quota of bytes through and parks the leg
 * again, so the test decides how much the peer takes between two budget windows. Preflight is
 * refused, so the upload runs on the legacy POST route: the one path that pipes a file at the daemon
 * and keeps going while the daemon drains it.
 */
export async function startParkedUploadDaemon(): Promise<ParkedUploadDaemon> {
  const requests: string[] = [];
  const parked: http.IncomingMessage[] = [];
  let receivedBytes = 0;
  let bytesTakenSinceRelease = 0;
  let parkedAtQuota: http.IncomingMessage | undefined;
  let bodyEnded = false;

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
        // Each release lets one quota of bytes through and parks the stream again. The client is
        // then backpressured for the rest of the window, so an artifact sized in megabytes is still
        // mid-flight when the next window is charged.
        bytesTakenSinceRelease += chunk.length;
        req.pause();
        if (bytesTakenSinceRelease < RELEASE_QUOTA_BYTES) parked.push(req);
        else parkedAtQuota = req;
      });
      req.on('end', () => {
        bodyEnded = true;
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
    get bodyEnded() {
      return bodyEnded;
    },
    releaseAllParked() {
      bytesTakenSinceRelease = 0;
      const resumable = parked.splice(0);
      if (parkedAtQuota) {
        resumable.push(parkedAtQuota);
        parkedAtQuota = undefined;
      }
      for (const entry of resumable) entry.resume();
    },
    close: () => closeLoopbackServer(server),
  };
}

export type ParkedUploadDaemon = {
  readonly baseUrl: string;
  readonly requests: readonly string[];
  /** Bytes the daemon has accepted for the upload leg. */
  readonly receivedBytes: number;
  /** True once the daemon has taken the whole upload body and only a response is owed. */
  readonly bodyEnded: boolean;
  /** Lets the parked body take up to one more quota of bytes. */
  releaseAllParked(): void;
  close(): Promise<void>;
};

/**
 * An origin that answers the upload leg and then stops reading its body.
 *
 * The answer can be an early 4xx, redirect or offset resume, which is the peer that replies while
 * the client still has bytes queued. Either way, taking one chunk and pausing is what keeps the
 * client's write pipeline in real backpressure when the answer lands, so a test can see whether the
 * owned file and request were closed and joined, or left writing at the old hop.
 */
export async function startAnswerUploadDaemon(options: {
  respond(req: http.IncomingMessage): {
    status: number;
    headers?: Record<string, string>;
    body: string;
  };
}): Promise<{
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: readonly string[];
  /** One entry per upload leg, in arrival order. */
  readonly legs: readonly UploadLeg[];
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const legs: UploadLeg[] = [];
  const server = http.createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    requests.push(key);
    // A new leg is where an overlap would become visible: every earlier leg is put back to reading,
    // so bytes its attempt is still pushing arrive and are counted rather than hiding in a paused
    // stream. A client that joined its previous attempt has nothing left to push, so its leg can
    // only report the bytes it took before the handoff.
    for (const earlier of legs) earlier.resumeFromHandoff();
    const leg = createUploadLeg(req);
    legs.push(leg);
    const answer = options.respond(req);
    res.statusCode = answer.status;
    for (const [name, value] of Object.entries(answer.headers ?? {})) {
      res.setHeader(name, value);
    }
    res.end(answer.body);
    // One chunk, then the peer stops: the client's remaining body stays queued behind this pause,
    // which is the backpressure the attempt has to be destroyed out of.
    req.pause();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.unref();
  const port = await listenOnLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    legs,
    close: () => closeLoopbackServer(server),
  };
}

export type UploadLeg = {
  readonly url: string;
  /** Bytes of this leg's body the origin has taken. */
  readonly bytes: number;
  /** Bytes taken at the moment the NEXT leg arrived; `undefined` while this is the newest leg. */
  readonly bytesAtNextLeg: number | undefined;
  /** True once the origin saw this leg's socket end. */
  readonly closed: boolean;
  /** Starts counting this leg's bytes again, as the handoff check does. */
  resumeFromHandoff(): void;
};

/** Internal counting state; published through the read-only `UploadLeg` view. */
type CountedUploadLeg = {
  -readonly [K in keyof UploadLeg]: UploadLeg[K];
};

function createUploadLeg(req: http.IncomingMessage): UploadLeg {
  const leg: CountedUploadLeg = {
    url: req.url ?? '',
    bytes: 0,
    bytesAtNextLeg: undefined,
    closed: false,
    resumeFromHandoff() {
      if (leg.bytesAtNextLeg !== undefined) {
        // Already past the handoff: keep counting whatever this attempt is still writing.
        req.resume();
        return;
      }
      leg.bytesAtNextLeg = leg.bytes;
      req.resume();
    },
  };
  req.on('data', (chunk: Buffer) => {
    leg.bytes += chunk.length;
  });
  req.on('error', () => {});
  req.on('aborted', () => {
    leg.closed = true;
  });
  req.socket.on('close', () => {
    leg.closed = true;
  });
  return leg;
}

/**
 * An HTTP origin that accepts the TCP connection and then reads nothing and never speaks.
 *
 * The connection IS carried, so the connect phase is over while the artifact never leaves the
 * client: the budget that has to expire is body inactivity. `bytesTaken` stays zero because the
 * origin pauses its sockets before the stream layer ever consumes a byte.
 */
export async function startConnectedStalledHttpOrigin(): Promise<{
  readonly port: number;
  readonly bytesTaken: number;
  close(): Promise<void>;
}> {
  let bytesTaken = 0;
  const server = net.createServer((socket) => {
    socket.pause();
    socket.on('data', (chunk: Buffer) => {
      bytesTaken += chunk.length;
    });
    socket.on('error', () => {});
  });
  server.unref();
  const port = await listenOnLoopback(server);
  return {
    port,
    get bytesTaken() {
      return bytesTaken;
    },
    close: () => closeLoopbackServer(server),
  };
}

/**
 * An HTTP origin that answers with one response-body chunk and then goes silent mid-body.
 *
 * The answer is streaming, so the budget that applies is response-body inactivity; the bytes the
 * client already consumed must survive to be reported, not be cut short with the socket.
 */
export async function startHalfAnsweredOrigin(options: { firstChunk: string }): Promise<{
  readonly baseUrl: string;
  close(): Promise<void>;
}> {
  const server = http.createServer((_req, res) => {
    _req.resume();
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.write(options.firstChunk);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.unref();
  const port = await listenOnLoopback(server);
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => closeLoopbackServer(server) };
}

/**
 * A loopback daemon that reads the upload body as it arrives — one parked chunk per release, so the
 * client writes only as fast as the test lets it — and answers once the body has ended.
 *
 * This is the peer a real daemon is: it takes every byte and eventually replies. Tests use it to
 * prove that an upload which keeps progressing finishes inside the phase budgets rather than being
 * cut short by one.
 */
export async function startSlowReadingUploadDaemon(options: {
  status: number;
  body: string;
}): Promise<{
  readonly baseUrl: string;
  readonly receivedBytes: number;
  readonly bodyEnded: boolean;
  readonly connections: number;
  releaseAllParked(): void;
  close(): Promise<void>;
}> {
  const parked: http.IncomingMessage[] = [];
  let receivedBytes = 0;
  let bodyEnded = false;
  let connections = 0;
  const server = http.createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    if (key === PREFLIGHT_REQUEST) {
      req.resume();
      req.on('end', () => {
        res.statusCode = 404;
        res.end('not found');
      });
      return;
    }
    req.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      req.pause();
      parked.push(req);
    });
    req.on('end', () => {
      bodyEnded = true;
      res.statusCode = options.status;
      res.end(options.body);
    });
  });
  server.on('connection', () => {
    connections += 1;
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.unref();
  const port = await listenOnLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get receivedBytes() {
      return receivedBytes;
    },
    get bodyEnded() {
      return bodyEnded;
    },
    get connections() {
      return connections;
    },
    releaseAllParked() {
      for (const entry of parked.splice(0)) entry.resume();
    },
    close: () => closeLoopbackServer(server),
  };
}

/**
 * An origin that accepts the TCP connection and never answers the TLS handshake.
 *
 * A plain socket sink is what keeps the handshake unfinished: the client's socket reports itself
 * encrypted and still connecting, `secureConnect` never fires, and the artifact piles up in the
 * write queue as `write()` keeps accepting it. That is the shape where bytes are already buffered at
 * the transport while the connection is still not carried, so the connect ceiling, not a body
 * budget, is what has to expire.
 */
export async function startUnfinishedHandshakeTlsOrigin(): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const server = net.createServer((socket) => {
    socket.pause();
    socket.on('error', () => {});
  });
  server.unref();
  const port = await listenOnLoopback(server);
  return { port, close: () => closeLoopbackServer(server) };
}

/**
 * A TLS origin that completes the handshake and then reads nothing and answers nothing.
 *
 * The connection IS carried here, so the connect phase is over while the artifact never leaves the
 * client's write queue: the budget that has to expire is body inactivity, reported with the body
 * ceiling rather than the connect one.
 */
export async function startConnectedStalledTlsOrigin(): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const server = tls.createServer(
    { key: readRepoFixture('localhost-key.pem'), cert: readRepoFixture('localhost-cert.pem') },
    (socket) => {
      socket.on('data', () => socket.pause());
      socket.on('error', () => {});
    },
  );
  server.unref();
  const port = await listenOnLoopback(server);
  return { port, close: () => closeLoopbackServer(server) };
}

/**
 * Trusts the repository's self-signed localhost certificate until restored.
 *
 * The subject builds TLS requests with the `node:https` global agent, so this is the agent's own
 * trust store: a test-local decision scoped to one `try/finally`, never a production option and
 * never the `NODE_TLS_REJECT_UNAUTHORIZED` switch, which a test could not put back.
 */
export function trustSelfSignedLocalhostCertificate(): { restore(): void } {
  const savedCa = https.globalAgent.options.ca;
  https.globalAgent.options.ca = readRepoFixture('localhost-cert.pem');
  return {
    restore() {
      https.globalAgent.options.ca = savedCa;
    },
  };
}

/**
 * A loopback daemon whose upload legs behave per a caller-supplied script.
 *
 * Leg one is where an upload completes and its socket returns to the pool; leg two is where the
 * next attempt runs on that reused connection. The script per leg says whether the peer reads the
 * whole body (`readAllBody`) and whether it answers at all, so a test can put the second attempt
 * into the header wait and prove the reused socket — no new connection, no connect phase — is what
 * the budget then times.
 */
export async function startUploadLegsDaemon(
  behaviors: readonly {
    readAllBody: boolean;
    respond?: () => { status: number; headers?: Record<string, string>; body: string };
  }[],
): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly string[];
  readonly connections: number;
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  let legs = 0;
  let connections = 0;
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const behavior = behaviors[legs];
    if (!behavior) throw new Error(`unexpected upload leg ${legs + 1}`);
    legs += 1;
    const answer = () => {
      if (!behavior.respond) return;
      const reply = behavior.respond();
      res.statusCode = reply.status;
      for (const [name, value] of Object.entries(reply.headers ?? {})) {
        res.setHeader(name, value);
      }
      res.end(reply.body);
    };
    if (behavior.readAllBody) {
      req.resume();
      req.on('end', answer);
      return;
    }
    let tookOneChunk = false;
    req.on('data', () => {
      if (tookOneChunk) return;
      tookOneChunk = true;
      req.pause();
    });
    answer();
  });
  server.on('connection', () => {
    connections += 1;
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.unref();
  const port = await listenOnLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get connections() {
      return connections;
    },
    close: () => closeLoopbackServer(server),
  };
}

function readRepoFixture(fileName: string): Buffer {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, 'test/integration/provider-scenarios/fixtures', fileName);
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
    dir = path.dirname(dir);
  }
  throw new Error(`missing ${fileName} under test/integration/provider-scenarios/fixtures`);
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
