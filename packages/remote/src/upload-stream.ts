import fs from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { addAbortSignal } from 'node:stream';
import { AppError } from '@agent-device/kernel/errors';
import {
  loadNodeHttpRequester,
  observeCompletedRequestWrites,
  readNodeHttpResponseBody,
} from '@agent-device/host-kit/transport';
import {
  createUploadProgressTransform,
  type UploadProgressSink,
  type UploadProgressStage,
} from './upload-progress.ts';

/** Ceiling for establishing the connection for each upload hop or offset resume. */
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
): Promise<T> {
  const deadline = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => {
    deadline.abort(
      new AppError('COMMAND_FAILED', 'Artifact preparation deadline exceeded', {
        reason: 'artifact_preparation_deadline_exceeded',
        transferPhase: 'preparation',
        timeoutMs: UPLOAD_PREPARATION_TIMEOUT_MS,
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
  errorMessage: string;
  errorHint?: string;
  retryable?: boolean;
  /**
   * The preparation aggregate `uploadArtifact` opened, combined with its caller's cancellation. Every
   * attempt, redirect and resume runs under it; none of them opens a deadline of its own.
   */
  signal: AbortSignal;
  progress?: UploadStreamProgressOptions;
}): Promise<UploadStreamResponse> {
  return await streamFileToHttpRequestAttempt({ ...options, redirectCount: 0, startOffset: 0 });
}

export function isRetryableUploadStreamError(error: unknown): boolean {
  return error instanceof AppError && error.details?.[UPLOAD_STREAM_RETRYABLE_DETAIL] === true;
}

async function streamFileToHttpRequestAttempt(options: {
  url: URL;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  payloadPath: string;
  errorMessage: string;
  errorHint?: string;
  retryable?: boolean;
  signal: AbortSignal;
  redirectCount: number;
  startOffset: number;
  progress?: UploadStreamProgressOptions;
}): Promise<UploadStreamResponse> {
  options.signal.throwIfAborted();
  // This module sits in the CLI's eager import closure via the remote-artifact
  // upload client, but only a remote daemon ever uploads, so the HTTP stack
  // loads here rather than at import time.
  const transport = await loadNodeHttpRequester(options.url.protocol);
  const payloadSize = fs.statSync(options.payloadPath).size;
  const headers = buildUploadRequestHeaders(options.headers, options.startOffset, payloadSize);
  emitUploadAttemptStarted(options.progress, options.startOffset, payloadSize);

  // A redirect or a resume is a new attempt with fresh phase timers under the same `options.signal`.
  const watchdog = createTransferPhaseWatchdog(options.signal);
  watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);

  // The owned pipeline (file → progress → request). Every exit joins it, so no owned byte overlaps
  // the outcome or the next hop.
  let upload: Promise<void> | undefined;
  let uploadSettled = false;
  let responseReceived = false;
  return await new Promise<UploadStreamResponse>((resolve, reject) => {
    let outgoingEnded = false;
    let transportEstablished = false;
    let bodyFlushed = false;
    const settle = (result: UploadStreamResponse) => {
      stopObservingWrites();
      watchdog.dispose();
      resolve(result);
    };
    const fail = (error: unknown) => {
      stopObservingWrites();
      watchdog.dispose();
      // The queued pipeline has to settle before the join in `finally`.
      req.destroy();
      reject(error);
    };
    // Buffered bytes are not transport progress: the connect ceiling counts until the transport is
    // carried. After that, an unflushed body is timed as inactivity and a flushed one waits on headers.
    const advanceOutgoingPhase = () => {
      if (responseReceived || watchdog.signal.aborted) return;
      if (!transportEstablished) return;
      if (bodyFlushed) {
        watchdog.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
      } else {
        watchdog.arm('request-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
      }
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
        // already piped at a device this client no longer holds the lease on. An expired phase
        // destroys it exactly like a cancellation does.
        signal: watchdog.signal,
      },
      (res) => {
        responseReceived = true;
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
        // Plain HTTP is carried on `connect`, TLS only once the handshake ends.
        const secured = (socket as { encrypted?: boolean }).encrypted === true;
        socket.once(secured ? 'secureConnect' : 'connect', () => {
          transportEstablished = true;
          advanceOutgoingPhase();
        });
      } else {
        transportEstablished = true;
        advanceOutgoingPhase();
      }
    });
    const stopObservingWrites = observeCompletedRequestWrites(req, watchdog.signal, () =>
      watchdog.touchBody(),
    );

    req.on('error', (err) => {
      if (responseReceived) return;
      // A cancellation or an expired phase is this client's own outcome, never a transport failure
      // that a retry or a legacy fallback could fix.
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
      // `finish`: this side's flush, not the peer's consumption, so the server owes an answer.
      bodyFlushed = true;
      advanceOutgoingPhase();
    })().catch((err: unknown) => {
      // After a response, only this attempt's own teardown ends the pipeline, and the server's
      // verdict stays the outcome: a 413 read completely is a 413, not a transport break.
      if (responseReceived) return;
      req.destroy();
      if (watchdog.signal.aborted) {
        fail(watchdog.signal.reason);
        return;
      }
      // A transport break reports through `error`, so this is the artifact read failing.
      const error = err instanceof Error ? err : new Error(String(err));
      fail(new AppError('COMMAND_FAILED', 'Failed to read local artifact', {}, error));
    });

    const endOutgoingWork = (): Promise<void> => {
      if (!outgoingEnded) {
        outgoingEnded = true;
        // The response is consumed, so a destroy cannot cut it short; it settles a pipeline blocked
        // on a peer that stopped reading. A flushed pipeline keeps its pooled socket.
        if (!uploadSettled) req.destroy();
      }
      return upload!.then(
        () => undefined,
        () => undefined,
      );
    };

    async function handleUploadResponse(res: IncomingMessage): Promise<UploadStreamResponse> {
      // Read the accepted answer to its end, then end and join the outgoing work before this attempt
      // resolves or the next hop starts.
      const body = await readNodeHttpResponseBody(res, () => watchdog.touchBody());
      await endOutgoingWork();
      stopObservingWrites();
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
