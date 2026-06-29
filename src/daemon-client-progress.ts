import http from 'node:http';
import type { Socket } from 'node:net';
import { AppError } from './kernel/errors.ts';
import type { DaemonRequest, DaemonResponse } from './daemon/types.ts';
import type { RequestProgressEvent } from './daemon/request-progress.ts';
import { consumeTextLines } from './utils/line-stream.ts';
import {
  createReplayTestProgressRenderer,
  type ReplayTestProgressRender,
} from './cli-test-progress.ts';
import {
  isDaemonProgressEnvelope,
  isDaemonResponseEnvelope,
  shouldStreamRequestProgress,
} from './daemon/request-progress-protocol.ts';

type RequestProgressRenderer = {
  render(event: RequestProgressEvent): ReplayTestProgressRender | undefined;
};

function createRequestProgressRenderer(req: DaemonRequest): RequestProgressRenderer {
  const replayProgressRenderer = createReplayTestProgressRenderer({
    verbose: Boolean(req.flags?.verbose || req.meta?.debug),
    liveProgress: shouldRenderLiveProgress(),
    columns: process.stderr.columns,
  });
  return {
    render(event) {
      if (event.type === 'command') {
        return { text: event.message, newline: true };
      }
      return replayProgressRenderer.render(event);
    },
  };
}

function writeRequestProgressEvent(
  event: RequestProgressEvent,
  renderer: RequestProgressRenderer,
): void {
  const output = renderer.render(event);
  if (!output) return;
  process.stderr.write(output.newline ? `${output.text}\n` : output.text);
}

function shouldRenderLiveProgress(): boolean {
  return process.stderr.isTTY === true && !process.env.CI;
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
    isSettled: () => boolean;
    resolve: (response: DaemonResponse) => void;
    reject: (error: unknown) => void;
    clearTimeout: () => void;
  },
): void {
  const { req, isSettled, resolve, reject, clearTimeout } = options;
  let buffer = '';
  const progressRenderer = createRequestProgressRenderer(req);

  const rejectInvalidLine = (line: string, error: unknown) => {
    clearTimeout();
    reject(
      new AppError(
        'COMMAND_FAILED',
        'Invalid daemon response',
        {
          requestId: req.meta?.requestId,
          line,
        },
        error instanceof Error ? error : undefined,
      ),
    );
  };

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    if (isSettled()) return;
    const parsed = consumeTextLines(buffer, chunk);
    buffer = parsed.buffer;
    for (const line of parsed.lines) {
      try {
        const message = JSON.parse(line) as unknown;
        if (isDaemonProgressEnvelope(message)) {
          writeRequestProgressEvent(message.event, progressRenderer);
          continue;
        }
        const response = isDaemonResponseEnvelope(message) ? message.response : message;
        clearTimeout();
        resolve(response as DaemonResponse);
        socket.end();
        return;
      } catch (error) {
        rejectInvalidLine(line, error);
        return;
      }
    }
  });
}

export function readDaemonHttpProgressResponse(
  res: http.IncomingMessage,
  options: {
    req: DaemonRequest;
    handleResponseBody: (body: string) => void;
    reject: (error: unknown) => void;
    clearTimeout: () => void;
  },
): void {
  const { req, handleResponseBody, reject, clearTimeout } = options;
  let buffer = '';
  let settled = false;
  const progressRenderer = createRequestProgressRenderer(req);
  const rejectInvalidLine = (line: string, error: unknown) => {
    settled = true;
    clearTimeout();
    reject(
      new AppError(
        'COMMAND_FAILED',
        'Invalid daemon response',
        {
          requestId: req.meta?.requestId,
          line,
        },
        error instanceof Error ? error : undefined,
      ),
    );
  };

  const handleLine = (line: string): boolean => {
    try {
      const message = JSON.parse(line) as unknown;
      if (isDaemonProgressEnvelope(message)) {
        writeRequestProgressEvent(message.event, progressRenderer);
        return false;
      }
      if (isDaemonResponseEnvelope<unknown>(message)) {
        settled = true;
        clearTimeout();
        handleResponseBody(JSON.stringify(message.response));
        return true;
      }
      throw new Error('Missing daemon progress response envelope');
    } catch (error) {
      rejectInvalidLine(line, error);
      return true;
    }
  };

  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    if (settled) return;
    const parsed = consumeTextLines(buffer, chunk);
    buffer = parsed.buffer;
    for (const line of parsed.lines) {
      if (line && handleLine(line)) return;
    }
  });
  res.on('end', () => {
    if (settled) return;
    const line = buffer.trim();
    if (line && handleLine(line)) return;
    settled = true;
    clearTimeout();
    reject(
      new AppError('COMMAND_FAILED', 'Invalid daemon response', {
        requestId: req.meta?.requestId,
        line,
      }),
    );
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
