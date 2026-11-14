// Support for the tests that put real budget pressure on a real artifact upload (#4441). The peer
// holds the body open chunk by chunk and the test drives the clock; sockets, framing and the client's
// own stream stay real, because a mocked transport cannot show what an owned pipeline was doing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import tls from 'node:tls';
import { onTestFinished, vi } from 'vitest';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { uploadArtifact } from '../../upload-client.ts';
import { type UploadStreamResponse, streamFileToHttpRequest } from '../../upload-stream.ts';

// Adopted phase budgets are independent expectations for the loopback tests.
export const TRANSFER_CONNECT_TIMEOUT_MS = 30_000;
export const TRANSFER_RESPONSE_HEADER_TIMEOUT_MS = 30_000;
export const TRANSFER_BODY_INACTIVITY_TIMEOUT_MS = 120_000;

export const PREFLIGHT_REQUEST = 'POST /upload/preflight';
export const LEGACY_UPLOAD_REQUEST = 'POST /upload';

/** Fine enough that no phase boundary is stepped over, cheap enough for minutes of budget. */
const BUDGET_STEP_MS = 5_000;

/** What the parked daemon takes per release: megabytes outlast the windows a test runs. */
const RELEASE_QUOTA_BYTES = 256 * 1024;

/** Anything whose settlement a test observes without awaiting it. */
export type Settles = { readonly settled: boolean };

/** The pending `untilIo` waits, each with the rejection the end of its test delivers. */
const ioWaiters = new Map<() => void, () => void>();
let ioWaitersEndWithTest = false;

/** Called by every owned I/O callback below, after it records what it observed. */
function noteIo(): void {
  for (const wake of ioWaiters.keys()) wake();
}

/**
 * Resolves once `ready` holds, rechecked after each owned I/O event below. It charges no budget and
 * counts no loop turns; a wait still pending when its test finishes is rejected with its stack.
 */
export async function untilIo(ready: () => boolean): Promise<void> {
  if (ready()) return;
  const unmet = new Error('untilIo: the I/O this wait needs never happened before its test ended');
  if (!ioWaitersEndWithTest) {
    ioWaitersEndWithTest = true;
    onTestFinished(() => {
      ioWaitersEndWithTest = false;
      for (const release of ioWaiters.values()) release();
      ioWaiters.clear();
    });
  }
  await new Promise<void>((resolve, reject) => {
    const wake = () => {
      try {
        if (!ready()) return;
        ioWaiters.delete(wake);
        resolve();
      } catch (error) {
        ioWaiters.delete(wake);
        reject(error);
      }
    };
    ioWaiters.set(wake, () => reject(unmet));
  });
}

/** Starts the clock every transfer budget in these tests is measured against. */
export function useTransferClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

/** An outcome observable without awaiting it, which a controlled clock needs. */
export type ObservedOutcome<T> = Promise<{ value: T | undefined; error: unknown }> & Settles;

function observeOutcome<T>(work: Promise<T>): ObservedOutcome<T> {
  let settled = false;
  const outcome = work.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as T | undefined, error }),
  );
  void outcome.then(() => {
    settled = true;
    noteIo();
  });
  return Object.defineProperty(outcome, 'settled', { get: () => settled }) as ObservedOutcome<T>;
}

export function startUpload(options: {
  baseUrl: string;
  artifactPath: string;
  signal?: AbortSignal;
}): ObservedOutcome<string> {
  return observeOutcome(
    uploadArtifact({
      env: process.env,
      localPath: options.artifactPath,
      baseUrl: options.baseUrl,
      token: 'daemon-token',
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  );
}

/** One attempt straight at `url`: the attempt lifecycle belongs to `streamFileToHttpRequest`. */
export function startUploadAttempt(options: {
  url: string;
  artifactPath: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  retryable?: boolean;
  signal?: AbortSignal;
}): ObservedOutcome<UploadStreamResponse> {
  return observeOutcome(
    streamFileToHttpRequest({
      url: new URL(options.url),
      method: options.method ?? 'POST',
      headers: options.headers ?? { authorization: 'Bearer daemon-token' },
      payloadPath: options.artifactPath,
      errorMessage: 'Failed to upload artifact to remote daemon',
      ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
      signal: options.signal ?? new AbortController().signal,
    }),
  );
}

/**
 * Spends `ms` of budget in `BUDGET_STEP_MS` steps, letting real socket work run between them, until
 * the transfer is over. A budget that fired is an answer, not a reason to keep ticking.
 */
export async function spendBudget(ms: number, transfer: Settles): Promise<void> {
  for (let elapsed = 0; elapsed < ms && !transfer.settled; elapsed += BUDGET_STEP_MS) {
    await vi.advanceTimersByTimeAsync(BUDGET_STEP_MS);
    await pumpRealWork();
  }
}

/**
 * Charges `windows` windows of `windowMs`, each only after one more completed write reached the
 * peer, and nothing before the first. Once the peer has the whole body, no growth is required.
 */
export async function spendProgressWindows(
  daemon: ParkedUploadDaemon,
  upload: Settles,
  options: { windows: number; windowMs: number; writes: OutgoingWrites },
): Promise<{ progressedInEveryWindow: boolean; budgetMs: number }> {
  await untilIo(() => upload.settled || (options.writes.completed > 0 && daemon.receivedBytes > 0));
  let progressedInEveryWindow = true;
  let spent = 0;
  for (let window = 0; window < options.windows; window += 1) {
    const bodyInFlight = !daemon.bodyEnded;
    const before = { bytes: daemon.receivedBytes, completed: options.writes.completed };
    daemon.releaseAllParked();
    const grew = bodyInFlight
      ? await awaitBodyProgress(daemon, options.writes, before, upload)
      : true;
    await vi.advanceTimersByTimeAsync(options.windowMs);
    spent += options.windowMs;
    if (upload.settled) break;
    if (!grew) progressedInEveryWindow = false;
  }
  return { progressedInEveryWindow, budgetMs: spent };
}

/**
 * Waits until the client completed one more body write and the peer took one more byte, or the
 * transfer settled. The parked peer is released again after each I/O event.
 */
export async function awaitBodyProgress(
  daemon: { readonly receivedBytes: number; releaseAllParked(): void },
  writes: OutgoingWrites,
  before: { bytes: number; completed: number },
  transfer: Settles,
): Promise<boolean> {
  const progressed = () =>
    writes.completed > before.completed && daemon.receivedBytes > before.bytes;
  await untilIo(() => {
    if (progressed() || transfer.settled) return true;
    daemon.releaseAllParked();
    return false;
  });
  return progressed();
}

/** The body writes of every outgoing request, totalled over the legs of one upload. */
export type OutgoingWrites = {
  /** `write` calls that returned `false`. */
  readonly falseReturns: number;
  /** Writes whose callback reported success: bytes handed to the local kernel. */
  readonly completed: number;
  readonly drains: number;
  /** Controlled-clock time of the newest leg's latest completed write. */
  readonly lastCompletedAt: number | undefined;
  /** True once the newest leg emitted `finish`: its whole body reached the transport. */
  readonly finished: boolean;
};

/** Records each outgoing request's writes, wrapped before the subject observes them. */
export function recordOutgoingWrites(): OutgoingWrites {
  const log: { -readonly [K in keyof OutgoingWrites]: OutgoingWrites[K] } = {
    falseReturns: 0,
    completed: 0,
    drains: 0,
    finished: false,
    lastCompletedAt: undefined,
  };
  const observe = (req: http.ClientRequest): http.ClientRequest => {
    log.finished = false;
    log.lastCompletedAt = undefined;
    const write = req.write;
    req.write = function (this: http.ClientRequest, ...writeArgs: unknown[]): boolean {
      const callbackIndex = typeof writeArgs[1] === 'function' ? 1 : 2;
      const callback = writeArgs[callbackIndex];
      writeArgs[callbackIndex] = (error?: Error | null) => {
        if (!error) {
          log.completed += 1;
          log.lastCompletedAt = vi.getMockedSystemTime()?.getTime();
        }
        if (typeof callback === 'function') callback(error);
        noteIo();
      };
      const accepted: boolean = Reflect.apply(write, this, writeArgs);
      if (!accepted) log.falseReturns += 1;
      noteIo();
      return accepted;
    };
    req.on('drain', () => {
      log.drains += 1;
      noteIo();
    });
    req.on('finish', () => {
      log.finished = true;
      noteIo();
    });
    return req;
  };
  const httpRequest = http.request;
  vi.spyOn(http, 'request').mockImplementation((...args) =>
    observe(Reflect.apply(httpRequest, http, args) as http.ClientRequest),
  );
  const httpsRequest = https.request;
  vi.spyOn(https, 'request').mockImplementation((...args) =>
    observe(Reflect.apply(httpsRequest, https, args) as http.ClientRequest),
  );
  return log;
}

/**
 * Spends budget until `ms` of it has passed since the newest leg's last completed write, charging
 * nothing before the first one. The kernel may still take bytes late after a stall began; each
 * completion comes from the callback the subject observes, so it moves both deadlines alike.
 */
export async function spendSinceLastWrite(
  ms: number,
  writes: OutgoingWrites,
  transfer: Settles,
): Promise<void> {
  await untilIo(() => writes.lastCompletedAt !== undefined || transfer.settled);
  while (!transfer.settled) {
    const remaining = (writes.lastCompletedAt ?? 0) + ms - controlledNow();
    if (remaining <= 0) return;
    await vi.advanceTimersByTimeAsync(Math.min(remaining, BUDGET_STEP_MS));
    await pumpRealWork();
  }
}

function controlledNow(): number {
  const now = vi.getMockedSystemTime();
  assert.ok(now, 'the transfer clock is installed');
  return now.getTime();
}

/** Gives an ended transfer the clock and loop turns its teardown needs; reports settlement. */
export async function settleAfterBudget(transfer: Settles): Promise<boolean> {
  for (let round = 0; round < 200 && !transfer.settled; round += 1) {
    await vi.advanceTimersByTimeAsync(100);
    await pumpRealWork(5);
  }
  return transfer.settled;
}

/**
 * Feeds the next `fs.createReadStream` from a source that holds `bytes` and never ends, so the
 * attempt's pipeline can stop only when the attempt destroys it, whatever the kernel buffers. The
 * open after it reads the real file and records whether this source was destroyed by then.
 */
export function holdArtifactSourceOpen(bytes = 0): {
  readonly source: PassThrough;
  readonly destroyedAtNextOpen: boolean | undefined;
} {
  const source = new PassThrough();
  if (bytes > 0) source.write(Buffer.alloc(bytes, 'x'));
  const open = fs.createReadStream;
  const held = { source, destroyedAtNextOpen: undefined as boolean | undefined };
  vi.spyOn(fs, 'createReadStream')
    .mockImplementationOnce(() => source as unknown as fs.ReadStream)
    .mockImplementationOnce((...args) => {
      held.destroyedAtNextOpen = source.destroyed;
      return Reflect.apply(open, fs, args);
    });
  return held;
}

/** Lets real socket work, such as a destroyed connection's close, run without spending budget. */
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

/** Listens on loopback without server ceilings, which would fire on the controlled clock. */
async function listenUntimed(server: net.Server): Promise<number> {
  if (server instanceof http.Server) {
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 0;
  }
  server.unref();
  return await listenOnLoopback(server);
}

/** Refuses preflight, so the upload runs on the legacy POST route that pipes the file. */
function refusedPreflight(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (`${req.method} ${req.url}` !== PREFLIGHT_REQUEST) return false;
  req.resume();
  req.on('end', () => {
    res.statusCode = 404;
    res.end('not found');
  });
  return true;
}

/**
 * A loopback daemon that parks the upload body a quota at a time and never answers it, so a test
 * decides how much the peer takes between two budget windows under real backpressure.
 */
export async function startParkedUploadDaemon(
  options: {
    /** Answers the first upload leg and stops reading it; later legs are parked at the quota. */
    answerFirstLeg?: { status: number; headers?: Record<string, string> };
  } = {},
): Promise<ParkedUploadDaemon> {
  const requests: string[] = [];
  const parked: http.IncomingMessage[] = [];
  let receivedBytes = 0;
  let bytesTakenSinceRelease = 0;
  let parkedAtQuota: http.IncomingMessage | undefined;
  let bodyEnded = false;
  let uploadLegs = 0;
  let newestParkedLeg: http.IncomingMessage | undefined;
  let readingToEnd = false;

  const server = http.createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    requests.push(key);
    noteIo();
    if (refusedPreflight(req, res)) return;
    if (key === LEGACY_UPLOAD_REQUEST) {
      uploadLegs += 1;
      // The client destroys a leg it has moved past, and a reset leg errors on this side too.
      req.on('error', () => {});
      const answer = options.answerFirstLeg;
      if (answer && uploadLegs === 1) {
        res.statusCode = answer.status;
        for (const [name, value] of Object.entries(answer.headers ?? {})) {
          res.setHeader(name, value);
        }
        res.end();
        req.pause();
        return;
      }
      newestParkedLeg = req;
      req.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        bytesTakenSinceRelease += chunk.length;
        if (!readingToEnd) {
          req.pause();
          if (bytesTakenSinceRelease < RELEASE_QUOTA_BYTES) parked.push(req);
          else parkedAtQuota = req;
        }
        noteIo();
      });
      req.on('end', () => {
        bodyEnded = true;
        noteIo();
      });
      return;
    }
    req.resume();
    req.on('end', () => {
      res.statusCode = 500;
      res.end('only the upload leg the test set up is expected');
    });
  });
  const port = await listenUntimed(server);
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
    readToEnd() {
      readingToEnd = true;
      for (const entry of parked.splice(0)) entry.resume();
      parkedAtQuota?.resume();
      parkedAtQuota = undefined;
    },
    resetParkedLeg() {
      assert.ok(newestParkedLeg, 'no parked leg to reset');
      newestParkedLeg.socket.resetAndDestroy();
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
  /** Stops parking: the daemon reads every remaining body byte as it arrives, still never answering. */
  readToEnd(): void;
  /** Resets the connection of the newest parked leg: a real peer reset, not a clean close. */
  resetParkedLeg(): void;
  close(): Promise<void>;
};

/**
 * An origin that answers each upload leg at once — an early 4xx, a redirect or an offset resume —
 * and then stops reading its body while the client still has bytes queued.
 */
export async function startAnswerUploadDaemon(options: {
  respond(req: http.IncomingMessage): {
    status: number;
    headers?: Record<string, string>;
    body: string;
  };
}) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.on('error', () => {});
    const answer = options.respond(req);
    res.statusCode = answer.status;
    for (const [name, value] of Object.entries(answer.headers ?? {})) {
      res.setHeader(name, value);
    }
    res.end(answer.body);
    req.pause();
  });
  const port = await listenUntimed(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => closeLoopbackServer(server),
  };
}

/**
 * An HTTP origin that accepts the TCP connection and then reads nothing and never speaks: the
 * connection is carried, so the budget that has to expire is body inactivity.
 */
export async function startConnectedStalledHttpOrigin() {
  let bytesTaken = 0;
  const server = net.createServer((socket) => {
    socket.pause();
    socket.on('data', (chunk: Buffer) => {
      bytesTaken += chunk.length;
    });
    socket.on('error', () => {});
  });
  const port = await listenUntimed(server);
  return {
    port,
    get bytesTaken() {
      return bytesTaken;
    },
    close: () => closeLoopbackServer(server),
  };
}

/** An HTTP origin that answers with one response-body chunk and then goes silent mid-body. */
export async function startHalfAnsweredOrigin(options: { firstChunk: string }) {
  const server = http.createServer((req, res) => {
    req.resume();
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.write(options.firstChunk);
  });
  const port = await listenUntimed(server);
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => closeLoopbackServer(server) };
}

/** A daemon that reads one parked chunk per release and answers once the body has ended. */
export async function startSlowReadingUploadDaemon(options: { status: number; body: string }) {
  const parked: http.IncomingMessage[] = [];
  let receivedBytes = 0;
  let bodyEnded = false;
  let connections = 0;
  const server = http.createServer((req, res) => {
    if (refusedPreflight(req, res)) return;
    req.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      req.pause();
      parked.push(req);
      noteIo();
    });
    req.on('end', () => {
      bodyEnded = true;
      res.statusCode = options.status;
      res.end(options.body);
      noteIo();
    });
  });
  server.on('connection', () => {
    connections += 1;
  });
  const port = await listenUntimed(server);
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
 * An origin that accepts the TCP connection and never answers the TLS handshake: the client's socket
 * stays encrypted and connecting while the artifact piles up in its write queue.
 */
export async function startUnfinishedHandshakeTlsOrigin() {
  const server = net.createServer((socket) => {
    socket.pause();
    socket.on('error', () => {});
  });
  const port = await listenUntimed(server);
  return { port, close: () => closeLoopbackServer(server) };
}

/** A TLS origin that completes the handshake and then reads nothing and answers nothing. */
export async function startConnectedStalledTlsOrigin() {
  const server = tls.createServer(
    { key: readRepoFixture('localhost-key.pem'), cert: readRepoFixture('localhost-cert.pem') },
    (socket) => {
      socket.on('data', () => socket.pause());
      socket.on('error', () => {});
    },
  );
  const port = await listenUntimed(server);
  return { port, close: () => closeLoopbackServer(server) };
}

/**
 * Trusts the repository's self-signed localhost certificate in the `node:https` global agent the
 * subject uses, until restored; never `NODE_TLS_REJECT_UNAUTHORIZED`, which a test cannot put back.
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

/** A daemon whose legs follow a script: whether the peer reads the whole body, and answers. */
export async function startUploadLegsDaemon(
  behaviors: readonly {
    readAllBody: boolean;
    respond?: () => { status: number; headers?: Record<string, string>; body: string };
  }[],
) {
  const requests: string[] = [];
  let legs = 0;
  let connections = 0;
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    noteIo();
    const behavior = behaviors[legs];
    if (!behavior) {
      res.statusCode = 500;
      res.end(`unexpected upload leg ${legs + 1}`);
      return;
    }
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
  const port = await listenUntimed(server);
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
