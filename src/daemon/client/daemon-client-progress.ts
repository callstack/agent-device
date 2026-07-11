import http from 'node:http';
import type { Socket } from 'node:net';
import { AppError } from '../../kernel/errors.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type { RequestProgressEvent, RequestProgressSink } from '../../request/progress.ts';
import { consumeTextLines } from '../../utils/line-stream.ts';
import { markDoctorProgressRendered } from '../../cli-doctor-output.ts';
import {
  isDaemonProgressEnvelope,
  isDaemonResponseEnvelope,
  shouldStreamRequestProgress,
} from '../request-progress-protocol.ts';

type ProgressLineReader = {
  handleLine(line: string): boolean;
};

type ProgressResponseFormat = 'socket-legacy' | 'ndjson-envelope';

function emitProgressEvent(
  event: RequestProgressEvent,
  options: {
    req: DaemonRequest;
    onProgress?: RequestProgressSink;
  },
): void {
  if (options.onProgress) {
    options.onProgress(event);
    return;
  }
  if (event.type === 'command') {
    if (options.req.command === 'doctor') markDoctorProgressRendered();
    process.stderr.write(`${event.message}\n`);
  }
}

function createInvalidDaemonResponseError(
  req: DaemonRequest,
  line: string,
  cause?: unknown,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Invalid daemon response',
    {
      requestId: req.meta?.requestId,
      line,
    },
    cause instanceof Error ? cause : undefined,
  );
}

function createProgressLineReader(options: {
  req: DaemonRequest;
  onProgress?: RequestProgressSink;
  responseFormat: ProgressResponseFormat;
  onResponse(response: DaemonResponse): void;
  onError(error: unknown): void;
}): ProgressLineReader {
  const finishWithError = (error: unknown): true => {
    options.onError(error);
    return true;
  };

  return {
    handleLine(line) {
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch (error) {
        return finishWithError(createInvalidDaemonResponseError(options.req, line, error));
      }

      if (isDaemonProgressEnvelope(message)) {
        try {
          emitProgressEvent(message.event, {
            req: options.req,
            onProgress: options.onProgress,
          });
          return false;
        } catch (error) {
          return finishWithError(error);
        }
      }

      if (isDaemonResponseEnvelope<DaemonResponse>(message)) {
        options.onResponse(message.response);
        return true;
      }

      if (options.responseFormat === 'socket-legacy') {
        options.onResponse(message as DaemonResponse);
        return true;
      }

      return finishWithError(
        createInvalidDaemonResponseError(
          options.req,
          line,
          new Error('Missing daemon progress response envelope'),
        ),
      );
    },
  };
}

export function shouldReadDaemonProgressStream(
  req: DaemonRequest,
  contentType: string | string[] | undefined,
): boolean {
  return (
    shouldStreamRequestProgress(req) &&
    String(Array.isArray(contentType) ? contentType.join(',') : (contentType ?? '')).includes(
      'application/x-ndjson',
    )
  );
}

export function readDaemonSocketProgressResponse(
  socket: Socket,
  options: {
    req: DaemonRequest;
    onProgress?: RequestProgressSink;
    isSettled: () => boolean;
    resolve: (response: DaemonResponse) => void;
    reject: (error: unknown) => void;
    clearTimeout: () => void;
  },
): void {
  const { req, isSettled, resolve, reject, clearTimeout } = options;
  let buffer = '';
  const lineReader = createProgressLineReader({
    req,
    onProgress: options.onProgress,
    responseFormat: 'socket-legacy',
    onResponse(response) {
      clearTimeout();
      resolve(response);
      socket.end();
    },
    onError(error) {
      clearTimeout();
      reject(error);
    },
  });

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    if (isSettled()) return;
    const parsed = consumeTextLines(buffer, chunk);
    buffer = parsed.buffer;
    for (const line of parsed.lines) {
      if (lineReader.handleLine(line)) return;
    }
  });
}

export function readDaemonHttpProgressResponse(
  res: http.IncomingMessage,
  options: {
    req: DaemonRequest;
    onProgress?: RequestProgressSink;
    handleResponseBody: (body: string) => void;
    reject: (error: unknown) => void;
    clearTimeout: () => void;
  },
): void {
  const { req, handleResponseBody, reject, clearTimeout } = options;
  let buffer = '';
  let settled = false;
  const lineReader = createProgressLineReader({
    req,
    onProgress: options.onProgress,
    responseFormat: 'ndjson-envelope',
    onResponse(response) {
      settled = true;
      clearTimeout();
      handleResponseBody(JSON.stringify(response));
    },
    onError(error) {
      settled = true;
      clearTimeout();
      reject(error);
    },
  });

  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    if (settled) return;
    const parsed = consumeTextLines(buffer, chunk);
    buffer = parsed.buffer;
    for (const line of parsed.lines) {
      if (line && lineReader.handleLine(line)) return;
    }
  });
  res.on('end', () => {
    if (settled) return;
    const line = buffer.trim();
    if (line && lineReader.handleLine(line)) return;
    settled = true;
    clearTimeout();
    reject(createInvalidDaemonResponseError(req, line));
  });
  res.on('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout();
    reject(
      new AppError(
        'COMMAND_FAILED',
        'Failed to read daemon response',
        { requestId: req.meta?.requestId },
        error instanceof Error ? error : undefined,
      ),
    );
  });
}
