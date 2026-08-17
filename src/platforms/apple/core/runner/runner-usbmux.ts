import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import http, { type IncomingMessage } from 'node:http';
import { type Socket } from 'node:net';
import { Deadline } from '../../../../utils/retry.ts';
import type { RunnerCommand } from './runner-contract.ts';
import { openUsbmuxRunnerSocket } from './runner-usbmux-protocol.ts';

const USBMUXD_SOCKET_PATH = '/var/run/usbmuxd';
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
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const agent = new http.Agent();
  agent.createConnection = (_options, callback) => {
    callback?.(null, socket);
    return socket;
  };
  try {
    const response = await requestRunnerCommand(agent, socket, body, requestSignal);
    return new Response((await readBoundedResponseBody(response)).toString('utf8'), {
      status: response.statusCode ?? 500,
    });
  } catch (error) {
    if (signal?.aborted) throw createRequestCanceledError();
    if (timeoutSignal.aborted) {
      throw new AppError('COMMAND_FAILED', 'Timed out waiting for XCTest runner over usbmux', {
        backend: 'xctest',
        timeoutMs,
      });
    }
    throw error;
  } finally {
    agent.destroy();
    socket.destroy();
  }
}

async function requestRunnerCommand(
  agent: http.Agent,
  socket: Socket,
  body: Buffer,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const request = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        path: '/command',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Connection: 'close',
        },
        agent,
        signal,
      },
      resolve,
    );
    request.once('error', reject);
    socket.resume();
    request.end(body);
  });
}

async function readBoundedResponseBody(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyBytes += buffer.length;
    if (bodyBytes > RUNNER_HTTP_MAX_BODY_BYTES) {
      throw new AppError('COMMAND_FAILED', 'XCTest runner response exceeded size limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function requireTimeRemaining(timeoutMs: number): void {
  if (timeoutMs > 0) return;
  throw new AppError('COMMAND_FAILED', 'No time remaining to send XCTest runner command', {
    backend: 'xctest',
    timeoutMs,
  });
}
