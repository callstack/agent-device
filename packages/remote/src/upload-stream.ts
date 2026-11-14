import fs from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { addAbortSignal } from 'node:stream';
import { AppError } from '@agent-device/kernel/errors';
import {
  createTransferPhaseWatchdog,
  loadNodeHttpRequester,
  observeClientRequestPhases,
  observeCompletedRequestWrites,
  readNodeHttpResponseBody,
  TRANSFER_CONNECT_TIMEOUT_MS,
} from '@agent-device/host-kit/transport';
import {
  createUploadProgressTransform,
  type UploadProgressSink,
  type UploadProgressStage,
} from './upload-progress.ts';

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
  /** All hops share the enclosing aggregate/caller signal. */
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

  const watchdog = createTransferPhaseWatchdog(options.signal);
  watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);

  let upload: Promise<void> | undefined;
  let uploadSettled = false;
  return await new Promise<UploadStreamResponse>((resolve, reject) => {
    let outgoingEnded = false;
    const settle = (result: UploadStreamResponse) => {
      phases.dispose();
      stopObservingWrites();
      watchdog.dispose();
      resolve(result);
    };
    const fail = (error: unknown) => {
      phases.dispose();
      stopObservingWrites();
      watchdog.dispose();
      req.destroy();
      reject(error);
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
        signal: watchdog.signal,
      },
      (res) => {
        addAbortSignal(watchdog.signal, res);
        void handleUploadResponse(res)
          .then((result) => settle(result))
          .catch((error: unknown) =>
            fail(watchdog.signal.aborted ? watchdog.signal.reason : error),
          );
      },
    );

    const phases = observeClientRequestPhases(req, watchdog);
    const stopObservingWrites = observeCompletedRequestWrites(req, watchdog.signal, () =>
      watchdog.touchBody(),
    );

    req.on('error', (err) => {
      if (phases.responseStarted) return;
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
    })().catch((err: unknown) => {
      // After a response, only this attempt's own teardown ends the pipeline, and the server's
      // verdict stays the outcome: a 413 read completely is a 413, not a transport break.
      if (phases.responseStarted) return;
      req.destroy();
      if (watchdog.signal.aborted) {
        fail(watchdog.signal.reason);
        return;
      }
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
      const body = await readNodeHttpResponseBody(res, () => watchdog.touchBody());
      await endOutgoingWork();
      phases.dispose();
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
