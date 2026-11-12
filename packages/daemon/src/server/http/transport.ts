import { readDevicePin } from '@agent-device/contracts/device';
import { isRecord } from '@agent-device/kernel/record';
import { readOptionalStringArrayField, type DaemonResponse } from '@agent-device/kernel/contracts';
import {
  AppError,
  createRequestCanceledError,
  malformedRequestDetails,
  normalizeError,
} from '@agent-device/kernel/errors';
import { AsyncResource } from 'node:async_hooks';
import net from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { DaemonInvokeFn, DaemonRequest } from '../../core/daemon-request.ts';
import { resolveDaemonRequestResultDeadlineMs } from '../../core/daemon-command-registry.ts';
import {
  clearRequestAbortRegistration,
  isRequestCanceled,
  markRequestCanceled,
  registerRequestAbort,
  resolveRequestTrackingId,
  withRequestProgressSink,
} from '@agent-device/host-kit/request';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { consumeTextLines } from '@agent-device/host-kit/transport';
import { DAEMON_REQUEST_MAX_BYTES } from '@agent-device/contracts/daemon-http';

import {
  serializeDaemonProgressEnvelope,
  serializeDaemonResponseEnvelope,
  shouldStreamRequestProgress,
} from '@agent-device/daemon-contracts/request-progress-protocol';

export type DaemonServer = (net.Server | HttpServer) & {
  destroyConnections?: () => void;
};

export function createSocketServer(handleRequest: DaemonInvokeFn): DaemonServer {
  const sockets = new Set<net.Socket>();
  const server: DaemonServer = net.createServer((socket) => {
    // An accepted socket loses the runtime that is listening, so its callbacks keep it explicitly.
    sockets.add(socket);
    socket.on(
      'close',
      AsyncResource.bind(() => sockets.delete(socket)),
    );
    let pending: PendingSocketRequest = EMPTY_PENDING_SOCKET_REQUEST;
    let inFlightRequests = 0;
    const activeRequestIds = new Set<string>();
    let canceledInFlight = false;
    // On disconnect, cancel only this connection's in-flight requests via their
    // request-scoped AbortSignals. That aborts runner work owned by those requests
    // without a global Apple runner abort, so an unrelated request's runner work
    // (or non-Apple work) is never torn down by another client's disconnect.
    const cancelInFlightRequests = () => {
      if (canceledInFlight || inFlightRequests === 0) return;
      canceledInFlight = true;
      for (const requestId of activeRequestIds) {
        markRequestCanceled(requestId);
      }
      emitDiagnostic({
        level: 'warn',
        phase: 'request_client_disconnected',
        data: {
          inFlightRequests,
        },
      });
    };
    socket.setEncoding('utf8');
    socket.on('close', AsyncResource.bind(cancelInFlightRequests));
    socket.on('error', AsyncResource.bind(cancelInFlightRequests));
    // An oversized request ends the connection, but only after the complete requests framed
    // before it are answered: the refusal is the last line this connection writes.
    let oversizedRequestRefusalPending = false;
    const refuseOversizedRequestWhenIdle = () => {
      if (!oversizedRequestRefusalPending || inFlightRequests > 0 || socket.destroyed) return;
      refuseOversizedSocketRequest(socket);
    };
    const answerSocketRequest = async (line: string): Promise<void> => {
      let response: DaemonResponse;
      inFlightRequests += 1;
      let requestIdForCleanup: string | undefined;
      let requestAbortRegistration: ReturnType<typeof registerRequestAbort>;
      let streamProgress = false;
      try {
        const req = parseSocketDaemonRequest(line);
        streamProgress = shouldStreamRequestProgress(req);
        requestIdForCleanup = resolveRequestTrackingId(req.meta?.requestId, 'socket');
        req.meta = {
          ...req.meta,
          requestId: requestIdForCleanup,
        };
        requestAbortRegistration = registerRequestAbort(requestIdForCleanup, undefined, {
          resultDeadlineMs: resolveDaemonRequestResultDeadlineMs(req),
        });
        activeRequestIds.add(requestIdForCleanup);
        if (isRequestCanceled(requestIdForCleanup)) {
          throw createRequestCanceledError();
        }
        response = await withRequestProgressSink(
          streamProgress
            ? (event) => {
                if (!socket.destroyed) {
                  socket.write(serializeDaemonProgressEnvelope(event));
                }
              }
            : undefined,
          async () => await handleRequest(req),
        );
      } catch (error) {
        response = { ok: false, error: normalizeError(error) };
      } finally {
        inFlightRequests -= 1;
        if (requestAbortRegistration) {
          activeRequestIds.delete(requestAbortRegistration.requestId);
        }
        clearRequestAbortRegistration(requestAbortRegistration);
      }
      if (!socket.destroyed) {
        socket.write(
          streamProgress
            ? serializeDaemonResponseEnvelope(response)
            : `${JSON.stringify(response)}\n`,
        );
      }
    };
    const onData = AsyncResource.bind(async (chunk: string) => {
      if (oversizedRequestRefusalPending) return;
      const framed = frameSocketRequests(pending, chunk);
      pending = framed.pending;
      if (framed.oversized) {
        oversizedRequestRefusalPending = true;
        socket.off('data', onData);
      }
      for (const line of framed.lines) await answerSocketRequest(line);
      refuseOversizedRequestWhenIdle();
    });
    socket.on('data', onData);
  });
  server.destroyConnections = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  };
  return server;
}

/** The unterminated tail of a connection's input, with its UTF-8 size kept as it grows. */
type PendingSocketRequest = Readonly<{ text: string; bytes: number }>;

const EMPTY_PENDING_SOCKET_REQUEST: PendingSocketRequest = { text: '', bytes: 0 };

/**
 * Splits a chunk into the complete requests to answer. A request past the byte limit, framed or
 * still unterminated, ends the framing: the requests before it are answered, nothing after it is.
 * A chunk without a newline only grows the pending tail, so a large request costs one pass.
 */
function frameSocketRequests(
  pending: PendingSocketRequest,
  chunk: string,
): { lines: string[]; pending: PendingSocketRequest; oversized: boolean } {
  if (!chunk.includes('\n')) {
    const grown = { text: pending.text + chunk, bytes: pending.bytes + Buffer.byteLength(chunk) };
    if (grown.bytes > DAEMON_REQUEST_MAX_BYTES) {
      return { lines: [], pending: EMPTY_PENDING_SOCKET_REQUEST, oversized: true };
    }
    return { lines: [], pending: grown, oversized: false };
  }
  const parsed = consumeTextLines(pending.text, chunk);
  const oversizedLine = parsed.lines.findIndex(exceedsDaemonRequestLimit);
  if (oversizedLine !== -1) {
    const lines = parsed.lines.slice(0, oversizedLine);
    return { lines, pending: EMPTY_PENDING_SOCKET_REQUEST, oversized: true };
  }
  const rest = { text: parsed.buffer, bytes: Buffer.byteLength(parsed.buffer) };
  if (rest.bytes > DAEMON_REQUEST_MAX_BYTES) {
    return { lines: parsed.lines, pending: EMPTY_PENDING_SOCKET_REQUEST, oversized: true };
  }
  return { lines: parsed.lines, pending: rest, oversized: false };
}

function exceedsDaemonRequestLimit(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') > DAEMON_REQUEST_MAX_BYTES;
}

function refuseOversizedSocketRequest(socket: net.Socket): void {
  const error = new AppError('INVALID_ARGS', 'Daemon request exceeds the size limit', {
    maxBytes: DAEMON_REQUEST_MAX_BYTES,
  });
  const response: DaemonResponse = { ok: false, error: normalizeError(error) };
  socket.end(`${JSON.stringify(response)}\n`);
}

function parseSocketDaemonRequest(line: string): DaemonRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed as DaemonRequest;
  }
  // `internal` carries daemon-issued capabilities and provenance. The socket is
  // a public transport like HTTP, so a token-bearing client must not be able to
  // forge those semantics even though the legacy socket request otherwise
  // preserves its existing raw wire shape.
  const { internal: _internal, ...request } = parsed as Record<string, unknown>;
  // Handlers join positionals into text, so a null or non-string element would reach them as
  // "" or "null". Refuse it here, with the same element check HTTP applies.
  try {
    readOptionalStringArrayField(request, 'positionals');
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid request: ${error instanceof Error ? error.message.replace(/^\$\./, '') : 'positionals'}`,
      malformedRequestDetails(),
    );
  }
  if (isRecord(request.meta)) {
    request.meta = { ...request.meta, devicePin: readDevicePin(request.meta.devicePin) };
  }
  return request as DaemonRequest;
}

export function listenNetServer(server: net.Server): Promise<number> {
  return listenLoopbackServer(server, 'Failed to bind socket server');
}

export function listenHttpServer(server: HttpServer): Promise<number> {
  return listenLoopbackServer(server, 'Failed to bind HTTP server');
}

function listenLoopbackServer(
  server: net.Server | HttpServer,
  errorMessage: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (typeof address === 'object' && address?.port) {
        resolve(address.port);
        return;
      }
      reject(new AppError('COMMAND_FAILED', errorMessage));
    });
  });
}
