import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { addAbortSignal } from 'node:stream';
import { AppError } from '@agent-device/kernel/errors';
import { loadNodeHttpRequester, readNodeHttpResponseBody } from '@agent-device/host-kit/transport';
import {
  createUploadProgressTransform,
  type UploadProgressSink,
  type UploadProgressStage,
} from './upload-progress.ts';
import { withUploadPreparationDeadline } from './upload-preparation-deadline.ts';

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

  let upload: Promise<void> | undefined;
  return await new Promise<UploadStreamResponse>((resolve, reject) => {
    let responseReceived = false;
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
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (res) => {
        responseReceived = true;
        if (options.signal) addAbortSignal(options.signal, res);
        void readNodeHttpResponseBody(res)
          .then((body) => {
            const statusCode = res.statusCode ?? 500;
            const location = res.headers.location;
            if (location && isUploadRedirectStatus(statusCode)) {
              if (options.redirectCount >= MAX_UPLOAD_REDIRECTS) {
                reject(
                  new AppError('COMMAND_FAILED', 'Artifact upload exceeded redirect limit', {
                    maxRedirects: MAX_UPLOAD_REDIRECTS,
                    url: options.url.toString(),
                  }),
                );
                return;
              }
              const redirectedUrl = new URL(location, options.url);
              // The request headers carry the daemon token or a signed ticket, and the body is the
              // artifact: neither may follow a hop to an origin the caller did not choose.
              if (redirectedUrl.origin !== options.url.origin) {
                reject(
                  new AppError(
                    'COMMAND_FAILED',
                    'Artifact upload refused a cross-origin redirect',
                    {
                      reason: 'cross-origin-redirect',
                      url: options.url.toString(),
                      redirectOrigin: redirectedUrl.origin,
                    },
                  ),
                );
                return;
              }
              void streamFileToHttpRequestAttempt({
                ...options,
                url: redirectedUrl,
                redirectCount: options.redirectCount + 1,
              }).then(resolve, reject);
              return;
            }

            const resumeOffset = isUploadResumeStatus(statusCode)
              ? parseUploadResumeOffset(res.headers, payloadSize)
              : undefined;
            if (resumeOffset !== undefined) {
              if (resumeOffset >= payloadSize) {
                resolve({
                  statusCode: 200,
                  statusMessage: 'Upload already complete',
                  body: '',
                });
                return;
              }
              if (resumeOffset <= options.startOffset) {
                reject(
                  new AppError('COMMAND_FAILED', 'Artifact upload resume did not advance', {
                    offset: resumeOffset,
                    previousOffset: options.startOffset,
                    url: options.url.toString(),
                  }),
                );
                return;
              }
              void streamFileToHttpRequestAttempt({
                ...options,
                startOffset: resumeOffset,
              }).then(resolve, reject);
              return;
            }

            resolve({
              statusCode,
              statusMessage: res.statusMessage,
              body,
            });
          })
          .catch((error: unknown) =>
            reject(options.signal?.aborted ? options.signal.reason : error),
          );
      },
    );

    req.on('error', (err) => {
      if (responseReceived) return;
      // A caller that canceled owns this outcome: the signal's reason is the answer, and wrapping it
      // as an ordinary transport failure would let a retry path treat "we stopped" as "it broke".
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      reject(
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
    upload = pipeline(
      fs.createReadStream(options.payloadPath, { start: options.startOffset }),
      createUploadProgressTransform({
        stage: options.progress?.stage ?? 'legacy',
        fileName: options.progress?.fileName ?? path.basename(options.payloadPath),
        startOffset: options.startOffset,
        totalBytes: payloadSize,
        onProgress: options.progress?.onProgress,
      }),
      req,
      { signal: options.signal },
    ).catch((err: unknown) => {
      if (responseReceived) return;
      req.destroy();
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      reject(new AppError('COMMAND_FAILED', 'Failed to read local artifact', {}, error));
    });
  }).finally(async () => {
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
