import fs from 'node:fs';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AppError } from './kernel/errors.ts';
import { readNodeHttpResponseBody } from './utils/node-http.ts';
import {
  createUploadProgressTransform,
  type UploadProgressSink,
  type UploadProgressStage,
} from './upload-progress.ts';

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
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
  progress?: UploadStreamProgressOptions;
}): Promise<UploadStreamResponse> {
  return await streamFileToHttpRequestAttempt({
    ...options,
    url: options.url,
    redirectCount: 0,
    startOffset: 0,
  });
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
  redirectCount: number;
  startOffset: number;
  progress?: UploadStreamProgressOptions;
}): Promise<UploadStreamResponse> {
  const transport = options.url.protocol === 'https:' ? https : http;
  const payloadSize = fs.statSync(options.payloadPath).size;
  const headers = buildUploadRequestHeaders(options.headers, options.startOffset, payloadSize);
  emitUploadAttemptStarted(options.progress, options.startOffset, payloadSize);

  return await new Promise((resolve, reject) => {
    let responseReceived = false;
    const req = transport.request(
      {
        protocol: options.url.protocol,
        host: options.url.hostname,
        port: options.url.port,
        method: options.method,
        path: options.url.pathname + options.url.search,
        headers,
      },
      (res) => {
        responseReceived = true;
        void readNodeHttpResponseBody(res)
          .then((body) => {
            clearTimeout(timeout);
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
          .catch(reject);
      },
    );

    const timeout = setTimeout(() => {
      req.destroy();
      reject(
        new AppError('COMMAND_FAILED', options.timeoutMessage, {
          timeoutMs: UPLOAD_TIMEOUT_MS,
          ...(options.timeoutHint ? { hint: options.timeoutHint } : {}),
          ...retryableUploadStreamDetail(options),
        }),
      );
    }, UPLOAD_TIMEOUT_MS);

    req.on('error', (err) => {
      if (responseReceived) return;
      clearTimeout(timeout);
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
    req.on('close', () => clearTimeout(timeout));

    void pipeline(
      fs.createReadStream(options.payloadPath, { start: options.startOffset }),
      createUploadProgressTransform({
        stage: options.progress?.stage ?? 'legacy',
        fileName: options.progress?.fileName ?? path.basename(options.payloadPath),
        startOffset: options.startOffset,
        totalBytes: payloadSize,
        onProgress: options.progress?.onProgress,
      }),
      req,
    ).catch((err: unknown) => {
      if (responseReceived) return;
      req.destroy();
      const error = err instanceof Error ? err : new Error(String(err));
      reject(new AppError('COMMAND_FAILED', 'Failed to read local artifact', {}, error));
    });
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
