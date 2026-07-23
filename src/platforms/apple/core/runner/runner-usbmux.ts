import { type Socket } from 'node:net';
import { AppError } from '../../../../kernel/errors.ts';
import { createRequestCanceledError } from '../../../../request/cancel.ts';
import { Deadline } from '../../../../utils/retry.ts';
import type { RunnerCommand } from './runner-contract.ts';
import { readSocketResponse } from './runner-socket-response.ts';
import { openUsbmuxRunnerSocket } from './runner-usbmux-protocol.ts';

const USBMUXD_SOCKET_PATH = '/var/run/usbmuxd';
const RUNNER_HTTP_MAX_HEADER_BYTES = 64 * 1024;
const RUNNER_HTTP_MAX_BODY_BYTES = 64 * 1024 * 1024;

export type UsbmuxRunnerTransport = {
  postCommand(
    deviceId: string,
    port: number,
    command: RunnerCommand,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response>;
};

export function createUsbmuxRunnerTransport(socketPath: string): UsbmuxRunnerTransport {
  return {
    postCommand: async (deviceId, port, command, timeoutMs, signal) => {
      const deadline = Deadline.fromTimeoutMs(timeoutMs);
      const socket = await openUsbmuxRunnerSocket(
        socketPath,
        deviceId,
        port,
        deadline.remainingMs(),
        signal,
      );
      try {
        return await postRunnerHttpCommand(socket, command, deadline.remainingMs(), signal);
      } catch (error) {
        socket.destroy();
        throw error;
      }
    },
  };
}

export const usbmuxRunnerTransport = createUsbmuxRunnerTransport(USBMUXD_SOCKET_PATH);

async function postRunnerHttpCommand(
  socket: Socket,
  command: RunnerCommand,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  requireTimeRemaining(timeoutMs);
  if (signal?.aborted) throw createRequestCanceledError();
  const body = Buffer.from(JSON.stringify(command), 'utf8');
  const request = Buffer.concat([
    Buffer.from(
      [
        'POST /command HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        `Content-Length: ${body.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
      'utf8',
    ),
    body,
  ]);
  const response = readSocketResponse<Response>({
    socket,
    timeoutMs,
    signal,
    completion: 'destroy',
    timeoutError: () =>
      new AppError('COMMAND_FAILED', 'Timed out waiting for XCTest runner over usbmux', {
        backend: 'xctest',
        timeoutMs,
      }),
    closedError: () =>
      new AppError('COMMAND_FAILED', 'XCTest runner closed usbmux before responding'),
    select: (buffer) => {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (buffer.length > RUNNER_HTTP_MAX_HEADER_BYTES) {
          return {
            error: new AppError('COMMAND_FAILED', 'XCTest runner returned oversized HTTP headers'),
          };
        }
        return;
      }
      const headersText = buffer.subarray(0, headerEnd).toString('utf8');
      const contentLength = readHttpContentLength(headersText);
      if (contentLength === undefined) {
        return {
          error: new AppError('COMMAND_FAILED', 'XCTest runner response omitted Content-Length'),
        };
      }
      if (contentLength > RUNNER_HTTP_MAX_BODY_BYTES) {
        return {
          error: new AppError('COMMAND_FAILED', 'XCTest runner response exceeded size limit'),
        };
      }
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) return;
      const status = readHttpStatus(headersText);
      const responseBody = buffer.subarray(bodyStart, bodyStart + contentLength);
      return { value: new Response(responseBody.toString('utf8'), { status }) };
    },
  });
  socket.write(request);
  return await response;
}

function readHttpContentLength(headers: string): number | undefined {
  const match = /^content-length:\s*(\d+)\s*$/im.exec(headers);
  const length = Number(match?.[1]);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

function readHttpStatus(headers: string): number {
  const status = Number(/^HTTP\/1\.[01]\s+(\d{3})\b/i.exec(headers)?.[1]);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
}

function requireTimeRemaining(timeoutMs: number): void {
  if (timeoutMs > 0) return;
  throw new AppError('COMMAND_FAILED', 'No time remaining to send XCTest runner command', {
    backend: 'xctest',
    timeoutMs,
  });
}
