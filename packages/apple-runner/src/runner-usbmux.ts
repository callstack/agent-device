import {
  AppError,
  createRequestCanceledError,
  discloseDispatch,
} from '@agent-device/kernel/errors';
import http, { type IncomingMessage } from 'node:http';
import { type Socket } from 'node:net';
import { Deadline } from './host.ts';
import {
  type RunnerCommand,
  runnerRequestHeaders,
  type RunnerEndpoint,
} from './runner-contract.ts';
import { openUsbmuxRunnerSocket } from './runner-usbmux-protocol.ts';

const USBMUXD_SOCKET_PATH = '/var/run/usbmuxd';
const RUNNER_HTTP_MAX_BODY_BYTES = 64 * 1024 * 1024;

export type UsbmuxRunnerTransport = {
  postCommand(
    deviceId: string,
    endpoint: RunnerEndpoint,
    command: RunnerCommand,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response>;
};

export function createUsbmuxRunnerTransport(socketPath: string): UsbmuxRunnerTransport {
  return {
    postCommand: async (deviceId, endpoint, command, timeoutMs, signal) => {
      const deadline = Deadline.fromTimeoutMs(timeoutMs);
      const socket = await openUsbmuxRunnerSocket(
        socketPath,
        deviceId,
        endpoint.port,
        deadline.remainingMs(),
        signal,
      ).catch((error: unknown) => {
        throw error instanceof AppError ? discloseDispatch(error, 'no') : error;
      });
      try {
        return await postRunnerHttpCommand(
          socket,
          endpoint,
          command,
          deadline.remainingMs(),
          signal,
        );
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
  endpoint: RunnerEndpoint,
  command: RunnerCommand,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  requireTimeRemaining(timeoutMs);
  if (signal?.aborted) throw createRequestCanceledError({ dispatched: 'no' });
  const body = Buffer.from(JSON.stringify(command), 'utf8');
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const agent = new http.Agent();
  agent.createConnection = (_options, callback) => {
    callback?.(null, socket);
    return socket;
  };
  try {
    const response = await requestRunnerCommand(agent, socket, endpoint, body, requestSignal);
    return new Response((await readBoundedResponseBody(response)).toString('utf8'), {
      status: response.statusCode ?? 500,
      headers: readResponseHeaders(response),
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
  endpoint: RunnerEndpoint,
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
          ...runnerRequestHeaders(endpoint),
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

function readResponseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
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
