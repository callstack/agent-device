import net from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { AppError, normalizeError } from '../../kernel/errors.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';
import {
  clearRequestAbortRegistration,
  createRequestCanceledError,
  isRequestCanceled,
  markRequestCanceled,
  registerRequestAbort,
  resolveRequestTrackingId,
} from '../../request/cancel.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { consumeTextLines } from '../../utils/line-stream.ts';
import { withRequestProgressSink } from '../../request/progress.ts';
import {
  serializeDaemonProgressEnvelope,
  serializeDaemonResponseEnvelope,
  shouldStreamRequestProgress,
} from '../request-progress-protocol.ts';

export type DaemonServer = (net.Server | HttpServer) & {
  destroyConnections?: () => void;
};

export function createSocketServer(handleRequest: DaemonInvokeFn): DaemonServer {
  const sockets = new Set<net.Socket>();
  const server: DaemonServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
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
    socket.on('close', cancelInFlightRequests);
    socket.on('error', cancelInFlightRequests);
    socket.on('data', async (chunk) => {
      const parsed = consumeTextLines(buffer, chunk);
      buffer = parsed.buffer;
      for (const line of parsed.lines) {
        let response: DaemonResponse;
        inFlightRequests += 1;
        let requestIdForCleanup: string | undefined;
        let requestAbortRegistration: ReturnType<typeof registerRequestAbort>;
        let streamProgress = false;
        try {
          const req = JSON.parse(line) as DaemonRequest;
          streamProgress = shouldStreamRequestProgress(req);
          requestIdForCleanup = resolveRequestTrackingId(req.meta?.requestId, 'socket');
          req.meta = {
            ...req.meta,
            requestId: requestIdForCleanup,
          };
          requestAbortRegistration = registerRequestAbort(requestIdForCleanup);
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
        } catch (err) {
          response = { ok: false, error: normalizeError(err) };
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
      }
    });
  });
  server.destroyConnections = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  };
  return server;
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
