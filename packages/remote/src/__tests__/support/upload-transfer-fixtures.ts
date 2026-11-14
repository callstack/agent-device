import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import tls from 'node:tls';
import { setTimeout as realSetTimeout, clearTimeout as realClearTimeout } from 'node:timers';
import { onTestFinished, vi } from 'vitest';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { uploadArtifact } from '../../upload-client.ts';
import { type UploadStreamResponse, streamFileToHttpRequest } from '../../upload-stream.ts';
export const TRANSFER_CONNECT_TIMEOUT_MS = 30_000;
export const TRANSFER_RESPONSE_HEADER_TIMEOUT_MS = 30_000;
export const TRANSFER_BODY_INACTIVITY_TIMEOUT_MS = 120_000;

export const PREFLIGHT_REQUEST = 'POST /upload/preflight';
export const LEGACY_UPLOAD_REQUEST = 'POST /upload';

const BUDGET_STEP_MS = 5_000;

const RELEASE_QUOTA_BYTES = 256 * 1024;

export type Settles = { readonly settled: boolean };

const ioWaiters = new Map<() => void, () => void>();
let ioWaitersEndWithTest = false;
let ioDeadline: number | undefined;

function noteIo(): void {
  for (const wake of ioWaiters.keys()) wake();
}

/** Charges no fake time; all pending waits share a 3s real diagnostic deadline per test. */
export async function untilIo(
  ready: () => boolean,
  label = 'I/O prerequisite',
  snapshot: () => unknown = () => ({}),
): Promise<void> {
  if (ready()) return;
  const unmet = new Error('untilIo: the I/O this wait needs never happened before its test ended');
  if (!ioWaitersEndWithTest) {
    ioWaitersEndWithTest = true;
    ioDeadline = performance.now() + 3_000;
    onTestFinished(() => {
      ioWaitersEndWithTest = false;
      ioDeadline = undefined;
      for (const release of ioWaiters.values()) release();
      ioWaiters.clear();
    });
  }
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      realClearTimeout(timer);
      ioWaiters.delete(wake);
      if (error) reject(error);
      else resolve();
    };
    const wake = () => {
      try {
        if (ready()) finish();
      } catch (error) {
        finish(error);
      }
    };
    const timer = realSetTimeout(
      () => {
        const error = new Error(`${label}: real I/O deadline; ${JSON.stringify(snapshot())}`, {
          cause: unmet,
        });
        finish(error);
      },
      Math.max(0, (ioDeadline ?? performance.now()) - performance.now()),
    );
    ioWaiters.set(wake, () => finish(unmet));
  });
}

export function useTransferClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

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

export async function spendBudget(ms: number, transfer: Settles): Promise<void> {
  for (let elapsed = 0; elapsed < ms && !transfer.settled; elapsed += BUDGET_STEP_MS) {
    await vi.advanceTimersByTimeAsync(BUDGET_STEP_MS);
    await pumpRealWork();
  }
}

export async function spendProgressWindows(
  daemon: ParkedUploadDaemon,
  upload: Settles,
  options: { windows: number; windowMs: number; writes: OutgoingWrites },
): Promise<{ progressedInEveryWindow: boolean; budgetMs: number }> {
  await untilIo(
    () => upload.settled || (options.writes.completed > 0 && daemon.receivedBytes > 0),
    'first body progress',
    () => ({
      writes: options.writes,
      receivedBytes: daemon.receivedBytes,
      requests: daemon.requests,
      settled: upload.settled,
    }),
  );
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

export async function awaitBodyProgress(
  daemon: { readonly receivedBytes: number; releaseAllParked(): void },
  writes: OutgoingWrites,
  before: { bytes: number; completed: number },
  transfer: Settles,
): Promise<boolean> {
  const progressed = () =>
    writes.completed > before.completed && daemon.receivedBytes > before.bytes;
  await untilIo(
    () => {
      if (progressed() || transfer.settled) return true;
      daemon.releaseAllParked();
      return false;
    },
    'next body progress',
    () => ({ writes, receivedBytes: daemon.receivedBytes, before, settled: transfer.settled }),
  );
  return progressed();
}

export type OutgoingWrites = {
  readonly falseReturns: number;
  /** Successful write callbacks mean local-kernel acceptance, not peer receipt. */
  readonly completed: number;
  readonly drains: number;
  readonly lastCompletedAt: number | undefined;
  readonly finished: boolean;
  readonly responseChunkRead: boolean;
};

export function recordOutgoingWrites(): OutgoingWrites {
  const log: { -readonly [K in keyof OutgoingWrites]: OutgoingWrites[K] } = {
    falseReturns: 0,
    completed: 0,
    drains: 0,
    finished: false,
    lastCompletedAt: undefined,
    responseChunkRead: false,
  };
  const observe = (req: http.ClientRequest): http.ClientRequest => {
    log.finished = false;
    log.lastCompletedAt = undefined;
    log.responseChunkRead = false;
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
    req.on('response', (res) => {
      res.once('data', () => {
        log.responseChunkRead = true;
        noteIo();
      });
    });
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

export async function settleAfterBudget(
  transfer: Settles,
  snapshot: () => unknown = () => transfer,
): Promise<void> {
  for (let round = 0; round < 200 && !transfer.settled; round += 1) {
    await vi.advanceTimersByTimeAsync(100);
    await pumpRealWork(5);
  }
  await untilIo(() => transfer.settled, 'settlement after phase expiry', snapshot);
}

/** Holds upload reads selected by start offset; metadata hashing remains real. */
export function holdArtifactSourceOpen(bytes = 0): {
  readonly source: PassThrough;
  readonly destroyedAtNextOpen: boolean | undefined;
} {
  const source = new PassThrough();
  onTestFinished(() => {
    source.destroy();
  });
  if (bytes > 0) source.write(Buffer.alloc(bytes, 'x'));
  const open = fs.createReadStream;
  const held = { source, destroyedAtNextOpen: undefined as boolean | undefined };
  let opened = false;
  vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
    const options = args[1];
    if (options && typeof options === 'object' && typeof options.start === 'number') {
      if (!opened) {
        opened = true;
        return source as unknown as fs.ReadStream;
      }
      held.destroyedAtNextOpen ??= source.destroyed;
    }
    return Reflect.apply(open, fs, args);
  });
  return held;
}

export async function pumpRealWork(rounds = 40): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function createArtifactFile(bytes: number, fileName = 'app.apk'): string {
  const dir = mkdtempForTestSync('agent-device-upload-phases-');
  const artifactPath = path.join(dir, fileName);
  fs.writeFileSync(artifactPath, Buffer.alloc(bytes, 'x'));
  return artifactPath;
}

async function listenUntimed(server: net.Server): Promise<number> {
  if (server instanceof http.Server) {
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 0;
  }
  server.unref();
  onTestFinished(() => closeLoopbackServer(server));
  return await listenOnLoopback(server);
}

function refusedPreflight(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (`${req.method} ${req.url}` !== PREFLIGHT_REQUEST) return false;
  req.resume();
  req.on('end', () => {
    res.statusCode = 404;
    res.end('not found');
  });
  return true;
}

export async function startParkedUploadDaemon(
  options: {
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
      req.on('error', () => {});
      const answer = options.answerFirstLeg;
      if (answer && uploadLegs === 1) {
        res.writeHead(answer.status, answer.headers);
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
  };
}

export type ParkedUploadDaemon = {
  readonly baseUrl: string;
  readonly requests: readonly string[];
  readonly receivedBytes: number;
  readonly bodyEnded: boolean;
  releaseAllParked(): void;
  readToEnd(): void;
  resetParkedLeg(): void;
};

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
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
    req.pause();
  });
  const port = await listenUntimed(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
  };
}

export async function startSilentTcpOrigin() {
  const server = net.createServer((socket) => {
    socket.pause();
    socket.on('error', () => {});
  });
  const port = await listenUntimed(server);
  return { port };
}

export async function startHalfAnsweredOrigin(options: { firstChunk: string }) {
  const server = http.createServer((req, res) => {
    req.resume();
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.write(options.firstChunk);
  });
  const port = await listenUntimed(server);
  return { baseUrl: `http://127.0.0.1:${port}` };
}

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
  };
}

export async function startConnectedStalledTlsOrigin() {
  const server = tls.createServer(
    { key: readRepoFixture('localhost-key.pem'), cert: readRepoFixture('localhost-cert.pem') },
    (socket) => {
      socket.on('data', () => socket.pause());
      socket.on('error', () => {});
    },
  );
  const port = await listenUntimed(server);
  return { port };
}

/** Restores the global agent even when later origin setup fails. */
export function trustSelfSignedLocalhostCertificate(): void {
  const savedCa = https.globalAgent.options.ca;
  https.globalAgent.options.ca = readRepoFixture('localhost-cert.pem');
  onTestFinished(() => {
    https.globalAgent.options.ca = savedCa;
  });
}

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
      res.writeHead(reply.status, reply.headers);
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
  };
}

function readRepoFixture(fileName: string): Buffer {
  return fs.readFileSync(
    new URL(
      `../../../../../test/integration/provider-scenarios/fixtures/${fileName}`,
      import.meta.url,
    ),
  );
}

export function assertDetailedError(
  error: unknown,
  details: Record<string, unknown>,
): asserts error is AppError {
  assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
  for (const [key, value] of Object.entries(details)) {
    assert.equal(error.details?.[key], value, `${key} of ${JSON.stringify(error.details)}`);
  }
}
