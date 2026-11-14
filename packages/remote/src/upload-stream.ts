import fs from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { addAbortSignal } from 'node:stream';
import { AppError } from '@agent-device/kernel/errors';
import { loadNodeHttpRequester } from '@agent-device/host-kit/transport';
import {
  createUploadProgressTransform,
  type UploadProgressSink,
  type UploadProgressStage,
} from './upload-progress.ts';

/**
 * Ceiling for establishing the connection one artifact-transfer attempt runs on.
 *
 * Kept beside its domain rather than on the socket: the same number governs every hop of an upload,
 * every offset resume and a standalone artifact download, so "how long may one hop take to connect"
 * has exactly one answer.
 */
export const TRANSFER_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Ceiling for waiting on response headers once this side has written everything the server is
 * waiting for. For an upload that is the moment its outgoing request body is fully flushed, never
 * the moment the request was created; for a bodyless request it is connection establishment.
 */
export const TRANSFER_RESPONSE_HEADER_TIMEOUT_MS = 30_000;

/**
 * Ceiling for silence between body bytes in either direction. Bytes actually written or read reset
 * it, so an artifact that keeps moving keeps its budget while a connection that stopped carrying
 * bytes does not. Progress never touches the aggregate budget the attempt runs under.
 */
export const TRANSFER_BODY_INACTIVITY_TIMEOUT_MS = 120_000;

export type TransferPhase = 'connect' | 'request-body' | 'response-headers' | 'response-body';

const BODY_PHASES: ReadonlySet<TransferPhase> = new Set(['request-body', 'response-body']);

/** The `details.reason` every phase expiry carries, so no consumer has to match error text. */
const TRANSFER_PHASE_TIMEOUT_REASON = 'transfer_phase_timeout';

/**
 * Watches the sequential phases of ONE transfer attempt.
 *
 * One attempt gets one watchdog: arming a later phase stops counting the earlier one, so the ceiling
 * that applies is always the phase the transfer is actually in. Progress re-arms only the two body
 * phases. Nothing here extends an enclosing aggregate budget — the caller's signal is combined in,
 * never replaced, so the earliest deadline still wins and every attempt, redirect and resume keeps
 * sharing the original aggregate.
 */
export type TransferPhaseWatchdog = {
  /** The signal the attempt runs on: the caller's cancellation plus every phase deadline. */
  signal: AbortSignal;
  /** Starts watching `phase`. The phase being watched before stops counting. */
  arm(phase: TransferPhase, timeoutMs: number): void;
  /** Records body bytes moving, so only the silence since the last byte counts against a body phase. */
  touchBody(): void;
  /** Stops the armed timer. Call it once the attempt is settled. */
  dispose(): void;
};

export function createTransferPhaseWatchdog(callerSignal?: AbortSignal): TransferPhaseWatchdog {
  const phase = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, phase.signal]) : phase.signal;
  let armed: { phase: TransferPhase; timeoutMs: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rearm = () => {
    if (timer !== undefined) clearTimeout(timer);
    const current = armed;
    if (!current) return;
    timer = setTimeout(() => {
      timer = undefined;
      phase.abort(createTransferPhaseTimeoutError(current.phase, current.timeoutMs));
    }, current.timeoutMs);
    timer.unref();
  };
  return {
    signal,
    arm(nextPhase, timeoutMs) {
      if (signal.aborted) return;
      armed = { phase: nextPhase, timeoutMs };
      rearm();
    },
    touchBody() {
      // Unrelated headers, keepalive traffic and timer callbacks are not body progress, and
      // progress in one phase buys no time in another: only a body phase already armed re-arms.
      if (!armed || !BODY_PHASES.has(armed.phase)) return;
      rearm();
    },
    dispose() {
      armed = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Typed evidence that a transfer phase, rather than the caller or the whole preparation aggregate,
 * ended the attempt. The expired phase and its effective budget travel in `details`.
 */
function createTransferPhaseTimeoutError(phase: TransferPhase, timeoutMs: number): AppError {
  return new AppError('COMMAND_FAILED', `Artifact transfer ${phase} timed out`, {
    reason: TRANSFER_PHASE_TIMEOUT_REASON,
    transferPhase: phase,
    timeoutMs,
  });
}

/** Whether `error` is a transfer phase's own expiry, which no fallback or retry may restart. */
export function isTransferPhaseTimeoutError(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === TRANSFER_PHASE_TIMEOUT_REASON;
}

/** The one artifact-preparation aggregate: ten minutes from admission to the last finalize. */
const UPLOAD_PREPARATION_TIMEOUT_MS = 600_000;

export async function withUploadPreparationDeadline<T>(
  callerSignal: AbortSignal | undefined,
  prepare: (signal: AbortSignal) => Promise<T>,
  timeout?: Readonly<{ message: string; hint?: string }>,
): Promise<T> {
  const deadline = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => {
    deadline.abort(
      new AppError('COMMAND_FAILED', timeout?.message ?? 'Artifact preparation deadline exceeded', {
        reason: 'artifact_preparation_deadline_exceeded',
        transferPhase: 'preparation',
        timeoutMs: UPLOAD_PREPARATION_TIMEOUT_MS,
        ...(timeout?.hint ? { hint: timeout.hint } : {}),
      }),
    );
  }, UPLOAD_PREPARATION_TIMEOUT_MS);
  timer.unref();
  try {
    const result = await prepare(signal);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const MAX_UPLOAD_REDIRECTS = 5;
const UPLOAD_STREAM_RETRYABLE_DETAIL = 'uploadStreamRetryable';

export type UploadStreamProgressOptions = {
  stage: UploadProgressStage;
  fileName: string;
  onProgress?: UploadProgressSink;
};

export type UploadStreamResponse = {
  statusCode: number;
  statusMessage?: string;
  body: string;
};

export async function streamFileToHttpRequest(options: {
  url: URL;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  payloadPath: string;
  timeoutMessage: string;
  timeoutHint?: string;
  errorMessage: string;
  errorHint?: string;
  retryable?: boolean;
  /** Ends this request when the work the upload serves is over; see `uploadArtifact`. */
  signal?: AbortSignal;
  progress?: UploadStreamProgressOptions;
}): Promise<UploadStreamResponse> {
  return await withUploadPreparationDeadline(
    options.signal,
    async (signal) =>
      await streamFileToHttpRequestAttempt({
        ...options,
        signal,
        url: options.url,
        redirectCount: 0,
        startOffset: 0,
      }),
    { message: options.timeoutMessage, hint: options.timeoutHint },
  );
}

export function isRetryableUploadStreamError(error: unknown): boolean {
  return error instanceof AppError && error.details?.[UPLOAD_STREAM_RETRYABLE_DETAIL] === true;
}

async function streamFileToHttpRequestAttempt(options: {
  url: URL;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  payloadPath: string;
  timeoutMessage: string;
  timeoutHint?: string;
  errorMessage: string;
  errorHint?: string;
  retryable?: boolean;
  signal?: AbortSignal;
  redirectCount: number;
  startOffset: number;
  progress?: UploadStreamProgressOptions;
}): Promise<UploadStreamResponse> {
  options.signal?.throwIfAborted();
  // This module sits in the CLI's eager import closure via the remote-artifact
  // upload client, but only a remote daemon ever uploads, so the HTTP stack
  // loads here rather than at import time.
  const transport = await loadNodeHttpRequester(options.url.protocol);
  const payloadSize = fs.statSync(options.payloadPath).size;
  const headers = buildUploadRequestHeaders(options.headers, options.startOffset, payloadSize);
  emitUploadAttemptStarted(options.progress, options.startOffset, payloadSize);

  // One watchdog for this attempt: connecting, then writing the body, then waiting for headers, then
  // reading the response. A redirect or a resume is a NEW attempt and starts fresh phase timers, but
  // it inherits `options.signal`, so the preparation aggregate the caller opened still expires it.
  const watchdog = createTransferPhaseWatchdog(options.signal);
  watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);

  // The attempt's owned outgoing pipeline: artifact file → progress transform → request. Every exit
  // from this attempt joins it, so no owned byte is still moving when the attempt resolves, fails,
  // or hands the body to a redirect/resume attempt.
  let upload: Promise<void> | undefined;
  let uploadSettled = false;
  let responseReceived = false;
  return await new Promise<UploadStreamResponse>((resolve, reject) => {
    let outgoingEnded = false;
    let transportEstablished = false;
    let bodyFlushed = false;
    const settle = (result: UploadStreamResponse) => {
      watchdog.dispose();
      resolve(result);
    };
    const fail = (error: unknown) => {
      watchdog.dispose();
      // Whatever is still queued on this attempt's own outgoing pipeline has to settle before the
      // join in `finally`, so a failure that ends the attempt destroys the request too. Once the
      // response has been consumed this cannot cut an accepted answer short; before it, the outcome
      // is already decided by this failure.
      req.destroy();
      reject(error);
    };
    // The phase this attempt is actually in, from the two events that can end the connect ceiling:
    // the transport carrying the protocol, and every body byte reaching the socket. A pooled socket
    // is already connected; a fresh one is not, and a TLS socket is not until its handshake ends.
    // Until then the connect ceiling keeps counting even when the whole body already sits in the
    // write buffer — buffered bytes are not transport progress. Once connected, a body the peer
    // stopped taking is timed as body inactivity, never as a connect timeout; a body that flushed
    // before the connection existed (a zero-length artifact) is already owed a response, so the
    // header wait is what it waits on.
    const advanceOutgoingPhase = () => {
      if (responseReceived || watchdog.signal.aborted) return;
      if (!transportEstablished) return;
      if (bodyFlushed) {
        watchdog.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
      } else {
        watchdog.arm('request-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
      }
    };
    // Body progress is what the socket accepted, which `drain` reports when a previously full write
    // queue empties. Chunks merely read ahead of the request, or throttled UI progress events, say
    // nothing about bytes leaving this machine, so they are not progress against any budget.
    const noteWriteProgress = () => {
      // A request-side drain says nothing about the response; once an answer is streaming, only
      // response bytes may re-arm the inactivity budget.
      if (responseReceived) return;
      watchdog.touchBody();
    };

    const req = transport.request(
      {
        protocol: options.url.protocol,
        host: options.url.hostname,
        port: options.url.port,
        method: options.method,
        path: options.url.pathname + options.url.search,
        headers,
        // Aborting destroys the request mid-stream, which is the only way to stop bytes that are
        // already piped at a device this client no longer holds the lease on.
        // This is the attempt's phase budget combined with the caller's signal, so an expired phase
        // destroys the socket exactly like a cancellation does.
        signal: watchdog.signal,
      },
      (res) => {
        responseReceived = true;
        // The response has started; from here the budget that matters is silence between body bytes.
        watchdog.arm('response-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
        addAbortSignal(watchdog.signal, res);
        void handleUploadResponse(res)
          .then((result) => settle(result))
          .catch((error: unknown) =>
            fail(watchdog.signal.aborted ? watchdog.signal.reason : error),
          );
      },
    );

    req.on('socket', (socket) => {
      if (socket.connecting) {
        // A fresh socket is not a connection yet: plain HTTP is carried when it connects, TLS only
        // when the handshake ends. Until then the connect ceiling keeps counting, whatever the
        // request's write buffer already holds.
        const secured = (socket as { encrypted?: boolean }).encrypted === true;
        socket.once(secured ? 'secureConnect' : 'connect', () => {
          transportEstablished = true;
          advanceOutgoingPhase();
        });
      } else {
        // A pooled socket — keep-alive reuse — is already carrying the protocol.
        transportEstablished = true;
        advanceOutgoingPhase();
      }
    });
    req.on('drain', noteWriteProgress);

    req.on('error', (err) => {
      if (responseReceived) return;
      // A caller that canceled owns this outcome: the signal's reason is the answer, and wrapping it
      // as an ordinary transport failure would let a retry path treat "we stopped" as "it broke".
      // An expired phase answers the same way — it is this client's own deadline, not a transport
      // failure a retry or a legacy fallback could fix.
      if (watchdog.signal.aborted) {
        fail(watchdog.signal.reason);
        return;
      }
      fail(
        new AppError(
          'COMMAND_FAILED',
          options.errorMessage,
          {
            ...(options.errorHint ? { hint: options.errorHint } : {}),
            ...retryableUploadStreamDetail(options),
          },
          err,
        ),
      );
    });

    // The owned outgoing work: the artifact file and the progress transform feeding the request.
    // `endOutgoingWork` stops it once the response has been consumed, and `upload` is the join that
    // proves the owned file handle and request are closed before this attempt reports its outcome.
    const fileStream = fs.createReadStream(options.payloadPath, { start: options.startOffset });
    const progressTransform = createUploadProgressTransform({
      stage: options.progress?.stage ?? 'legacy',
      fileName: options.progress?.fileName ?? path.basename(options.payloadPath),
      startOffset: options.startOffset,
      totalBytes: payloadSize,
      onProgress: options.progress?.onProgress,
    });
    upload = (async () => {
      await pipeline(fileStream, progressTransform, req, { signal: watchdog.signal });
      uploadSettled = true;
      // `pipeline` settles on the request's `finish`: every body byte has been flushed into the
      // transport. The server may still be reading them — normal HTTP buffering — so this is this
      // side's flush, not the peer's consumption; it is still the point where the server owes an
      // answer. If the TLS handshake has not completed under that flush, the connect ceiling is
      // still the live budget and the header wait is armed when it does.
      bodyFlushed = true;
      advanceOutgoingPhase();
    })().catch((err: unknown) => {
      // After the response has been consumed to its end, this pipeline can only have been ended by
      // the teardown that consumed it: the attempt destroys its own request at that point. The
      // accepted answer is the outcome, and a rejection from our own destroy must not overwrite the
      // server's verdict — a 413 that the client read completely is a 413, not a transport break.
      if (responseReceived) return;
      req.destroy();
      if (watchdog.signal.aborted) {
        fail(watchdog.signal.reason);
        return;
      }
      // Before any response, a rejection here is the artifact failing to reach the socket: the real
      // read failure the caller has to see, never a swallowed transport error, because a transport
      // break reports through the request's own `error` handler.
      const error = err instanceof Error ? err : new Error(String(err));
      fail(new AppError('COMMAND_FAILED', 'Failed to read local artifact', {}, error));
    });

    const endOutgoingWork = (): Promise<void> => {
      if (!outgoingEnded) {
        outgoingEnded = true;
        // The response has been consumed to its end, so destroying the request can no longer cut it
        // short. Destroying it is what settles a pipeline still blocked on a peer that stopped
        // reading: the owned file handle and the socket close now, not whenever the peer catches
        // up. A pipeline that already flushed everything has nothing left to stop, and its socket
        // stays in the pool exactly as it did before.
        if (!uploadSettled) req.destroy();
      }
      return upload!.then(
        () => undefined,
        () => undefined,
      );
    };

    async function handleUploadResponse(res: IncomingMessage): Promise<UploadStreamResponse> {
      // Read the accepted response to its end first, under the response-body budget; only then may
      // the outgoing work be destroyed, and it must be joined before this attempt resolves or a
      // redirect/resume starts — old bytes may never overlap the next hop.
      const body = await readUploadResponseBody(res, () => watchdog.touchBody());
      await endOutgoingWork();
      watchdog.dispose();

      const statusCode = res.statusCode ?? 500;
      const location = res.headers.location;
      if (location && isUploadRedirectStatus(statusCode)) {
        if (options.redirectCount >= MAX_UPLOAD_REDIRECTS) {
          throw new AppError('COMMAND_FAILED', 'Artifact upload exceeded redirect limit', {
            maxRedirects: MAX_UPLOAD_REDIRECTS,
            url: options.url.toString(),
          });
        }
        const redirectedUrl = new URL(location, options.url);
        // The request headers carry the daemon token or a signed ticket, and the body is the
        // artifact: neither may follow a hop to an origin the caller did not choose.
        if (redirectedUrl.origin !== options.url.origin) {
          throw new AppError('COMMAND_FAILED', 'Artifact upload refused a cross-origin redirect', {
            reason: 'cross-origin-redirect',
            url: options.url.toString(),
            redirectOrigin: redirectedUrl.origin,
          });
        }
        return await streamFileToHttpRequestAttempt({
          ...options,
          url: redirectedUrl,
          redirectCount: options.redirectCount + 1,
        });
      }

      const resumeOffset = isUploadResumeStatus(statusCode)
        ? parseUploadResumeOffset(res.headers, payloadSize)
        : undefined;
      if (resumeOffset !== undefined) {
        if (resumeOffset >= payloadSize) {
          return { statusCode: 200, statusMessage: 'Upload already complete', body: '' };
        }
        if (resumeOffset <= options.startOffset) {
          throw new AppError('COMMAND_FAILED', 'Artifact upload resume did not advance', {
            offset: resumeOffset,
            previousOffset: options.startOffset,
            url: options.url.toString(),
          });
        }
        return await streamFileToHttpRequestAttempt({
          ...options,
          startOffset: resumeOffset,
        });
      }

      return { statusCode, statusMessage: res.statusMessage, body };
    }
  }).finally(async () => {
    watchdog.dispose();
    await upload;
  });
}

function retryableUploadStreamDetail(options: { retryable?: boolean }): Record<string, true> {
  return options.retryable === true ? { [UPLOAD_STREAM_RETRYABLE_DETAIL]: true } : {};
}

/**
 * Reads a response body as text, reporting each chunk so an inactivity budget can tell a slow
 * transfer from a stalled one.
 *
 * The shared host-kit reader is deliberately not reused here: it has no notion of progress, and
 * widening it for one transfer family would move an unrelated transport owner's surface.
 */
function readUploadResponseBody(res: IncomingMessage, onBytes: () => void): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      onBytes();
      body += chunk;
    });
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });
}

function emitUploadAttemptStarted(
  progress: UploadStreamProgressOptions | undefined,
  startOffset: number,
  totalBytes: number,
): void {
  progress?.onProgress?.({
    type: startOffset > 0 ? 'resume' : 'start',
    stage: progress.stage,
    fileName: progress.fileName,
    transferredBytes: startOffset,
    totalBytes,
  });
}

function buildUploadRequestHeaders(
  headers: Record<string, string>,
  startOffset: number,
  payloadSize: number,
): Record<string, string | number> {
  if (startOffset <= 0) return headers;
  return {
    ...headers,
    'content-length': Math.max(payloadSize - startOffset, 0),
    'content-range': `bytes ${startOffset}-${payloadSize - 1}/${payloadSize}`,
  };
}

function isUploadRedirectStatus(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function isUploadResumeStatus(statusCode: number): boolean {
  return statusCode === 308;
}

function parseUploadResumeOffset(
  headers: IncomingHttpHeaders,
  payloadSize: number,
): number | undefined {
  const explicitOffset = parseNonNegativeIntegerHeader(
    headers['x-upload-offset'] ?? headers['upload-offset'],
  );
  if (explicitOffset !== undefined) {
    return Math.min(explicitOffset, payloadSize);
  }

  const range = firstHeaderValue(headers.range);
  const match = range?.match(/^bytes=0-(\d+)$/);
  if (!match) return undefined;
  const endOffset = Number(match[1]);
  if (!Number.isSafeInteger(endOffset) || endOffset < 0) return undefined;
  return Math.min(endOffset + 1, payloadSize);
}

function parseNonNegativeIntegerHeader(value: string | string[] | undefined): number | undefined {
  const raw = firstHeaderValue(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
