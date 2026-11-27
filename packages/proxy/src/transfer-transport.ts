import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import {
  createTransferPhaseWatchdog,
  isTransferPhaseTimeoutError,
  loadNodeHttpRequester,
  observeClientRequestPhases,
  observeCompletedRequestWrites,
  TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  TRANSFER_CONNECT_TIMEOUT_MS,
  TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
  type TransferPhaseWatchdog,
} from '@agent-device/host-kit/transport';
import { NULL_BODY_STATUSES, responseHeadersOf } from '@agent-device/host-kit/direct-http';

const PROXY_TRANSFER_AGGREGATE_MS = 600_000;

/** Why the proxy's own transfer hop gives up on the exchange. */
const TRANSFER_FORWARDING_REASONS = {
  // The whole exchange outlived the proxy's aggregate forwarding budget.
  forwardingDeadline: { reason: 'transfer_forwarding_deadline_exceeded' },
  // The upstream daemon answered with a status that is not an HTTP response this proxy may relay.
  gatewayStatus: { reason: 'transfer_gateway_status' },
  // The upstream daemon closed the connection before it answered, or during a write.
  upstreamClosed: { reason: 'transfer_upstream_closed' },
} as const satisfies ReasonTable<'proxy'>;

/** Forwards one exchange over `node:http(s)`, without redirects or retries; plain http goes direct. */
export function createNodeTransferFetch(): (request: Request) => Promise<Response> {
  return async (request) => {
    const exchange = openExchange(request.signal);
    try {
      return await exchangeOverNodeHttp(request, exchange);
    } catch (error) {
      exchange.dispose();
      throw error;
    }
  };
}

/** Bounds proxy-owned waits; opaque transport work and cancellation callbacks are never joined. */
export async function settleUpstreamFetch(
  upstreamFetch: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  const exchange = openExchange(request.signal);
  let response: Response | undefined;
  try {
    response = await untilAborted(
      exchange.signal,
      () => upstreamFetch(new Request(request, { signal: exchange.signal })),
      (late) => cancelForeignBody(late.body),
    );
    if (!response.body) {
      exchange.dispose();
      return response;
    }
    return new Response(
      demandAwareStream(foreignBodySource(response.body), exchange, () => {
        exchange.dispose();
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  } catch (error) {
    const failure = exchange.classify(error);
    cancelForeignBody(response?.body ?? null);
    exchange.dispose();
    throw failure;
  }
}

export function transferWireDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') return {};
  const { reason, transferPhase, timeoutMs } = error.details ?? {};
  if (reason === TRANSFER_FORWARDING_REASONS.forwardingDeadline.reason) {
    return transferPhase === 'forwarding' && timeoutMs === PROXY_TRANSFER_AGGREGATE_MS
      ? { reason, transferPhase, timeoutMs }
      : {};
  }
  if (!isTransferPhaseTimeoutError(error)) return {};
  let phaseBudgetMs: number;
  switch (transferPhase) {
    case 'connect':
      phaseBudgetMs = TRANSFER_CONNECT_TIMEOUT_MS;
      break;
    case 'response-headers':
      phaseBudgetMs = TRANSFER_RESPONSE_HEADER_TIMEOUT_MS;
      break;
    case 'request-body':
    case 'response-body':
      phaseBudgetMs = TRANSFER_BODY_INACTIVITY_TIMEOUT_MS;
      break;
    default:
      return {};
  }
  return timeoutMs === phaseBudgetMs ? { reason, transferPhase, timeoutMs } : {};
}

type TransferExchange = {
  signal: AbortSignal;
  watchdog: TransferPhaseWatchdog;
  classify(error: unknown): unknown;
  cancel(reason?: unknown): void;
  dispose(): void;
};

function openExchange(caller: AbortSignal): TransferExchange {
  const forwarding = new AbortController();
  const timer = setTimeout(
    () =>
      forwarding.abort(
        new AppError('COMMAND_FAILED', 'Proxy transfer forwarding deadline exceeded', {
          reason: TRANSFER_FORWARDING_REASONS.forwardingDeadline.reason,
          transferPhase: 'forwarding',
          timeoutMs: PROXY_TRANSFER_AGGREGATE_MS,
        }),
      ),
    PROXY_TRANSFER_AGGREGATE_MS,
  );
  timer.unref();
  const watchdog = createTransferPhaseWatchdog(AbortSignal.any([caller, forwarding.signal]));
  return {
    signal: watchdog.signal,
    watchdog,
    classify: (error) => (watchdog.signal.aborted ? watchdog.signal.reason : error),
    cancel: (reason) => forwarding.abort(reason),
    dispose: () => {
      clearTimeout(timer);
      watchdog.dispose();
    },
  };
}

async function exchangeOverNodeHttp(
  request: Request,
  exchange: TransferExchange,
): Promise<Response> {
  const url = new URL(request.url);
  const [transport, { urlToHttpOptions }] = await untilAborted(exchange.signal, () =>
    Promise.all([
      loadNodeHttpRequester(url, { subject: 'Proxy upstreamBaseUrl' }),
      import('node:url'),
    ]),
  );
  exchange.signal.throwIfAborted();
  const { auth: _auth, ...target } = urlToHttpOptions(url);
  const options: RequestOptions = {
    ...target,
    method: request.method,
    path: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    signal: exchange.signal,
  };
  exchange.watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
  return await new Promise<Response>((resolve, reject) => {
    const outgoingStopped = new AbortController();
    const requestClosed = new AbortController();
    let answered = false;
    let response: IncomingMessage | undefined;
    let responseClosed: Promise<void> = Promise.resolve();
    let finishing: Promise<void> | undefined;
    const finish = () => {
      if (finishing) return finishing;
      outgoingStopped.abort();
      // A flushed request can already have returned its socket to the global pool.
      if (!req.writableFinished && !req.closed) req.destroy();
      finishing = Promise.all([pump, reqClosed, responseClosed]).then(() => {
        phases.dispose();
        stopObservingWrites();
        req.off('error', fail);
        response?.off('error', fail);
        exchange.signal.removeEventListener('abort', onAbort);
        exchange.dispose();
      });
      return finishing;
    };
    const fail = (error: unknown) => {
      if (answered) return;
      answered = true;
      const failure = exchange.classify(error);
      response?.destroy();
      req.destroy();
      void finish().then(() => reject(failure));
    };
    const req = transport.request(options, (res) => {
      response = res;
      responseClosed = new Promise<void>((closed) => res.once('close', closed));
      res.on('error', fail);
      if (answered || exchange.signal.aborted) {
        res.destroy();
        fail(exchange.signal.reason);
        return;
      }
      const status = res.statusCode ?? 500;
      if (status < 200 || status > 599) {
        fail(
          new AppError('COMMAND_FAILED', 'Upstream daemon returned an unusable HTTP status', {
            reason: TRANSFER_FORWARDING_REASONS.gatewayStatus.reason,
            status,
          }),
        );
        return;
      }
      answered = true;
      outgoingStopped.abort();
      exchange.watchdog.suspend();
      const headers = responseHeadersOf(res);
      if (request.method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
        res.resume();
        void responseClosed.then(finish);
        resolve(new Response(null, { status, headers }));
        return;
      }
      resolve(
        new Response(demandAwareStream(nodeBodySource(res), exchange, finish), {
          status,
          headers,
        }),
      );
    });
    const reqClosed = new Promise<void>((closed) => {
      req.once('close', () => {
        requestClosed.abort();
        closed();
        if (!answered)
          fail(
            new AppError('COMMAND_FAILED', 'Upstream daemon closed before responding', {
              reason: TRANSFER_FORWARDING_REASONS.upstreamClosed.reason,
            }),
          );
      });
    });
    req.on('error', fail);
    const phases = observeClientRequestPhases(req, exchange.watchdog);
    const stopObservingWrites = observeCompletedRequestWrites(req, exchange.signal, () => {
      exchange.watchdog.touchBody();
    });
    const onAbort = () => {
      response?.destroy();
      fail(exchange.signal.reason);
    };
    exchange.signal.addEventListener('abort', onAbort, { once: true });
    const pump = pumpOutgoing(
      request,
      req,
      exchange.signal,
      AbortSignal.any([exchange.signal, outgoingStopped.signal, requestClosed.signal]),
    ).catch(fail);
    if (exchange.signal.aborted) onAbort();
  });
}

async function pumpOutgoing(
  request: Request,
  req: ClientRequest,
  lifetime: AbortSignal,
  stopped: AbortSignal,
): Promise<void> {
  if (stopped.aborted) return;
  if (!request.body) {
    req.end();
    return;
  }
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await untilAborted(stopped, () => reader.read());
      if (stopped.aborted) return;
      if (done) {
        req.end();
        return;
      }
      if (value.byteLength === 0) {
        await yieldTransferEvents(stopped);
        continue;
      }
      if (!req.write(value)) await waitUntilDrained(req, stopped);
    }
  } catch (error) {
    if (!stopped.aborted) throw error;
  } finally {
    // Releasing a pending read rejects that read without cancelling the incoming client socket.
    if (lifetime.aborted) void reader.cancel(lifetime.reason).catch(() => undefined);
    reader.releaseLock();
  }
}

function waitUntilDrained(req: ClientRequest, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      req.off('drain', drained);
      signal.removeEventListener('abort', aborted);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    req.once('drain', drained);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else if (req.destroyed || req.closed) {
      cleanup();
      reject(
        new AppError('COMMAND_FAILED', 'Upstream daemon closed during a write', {
          reason: TRANSFER_FORWARDING_REASONS.upstreamClosed.reason,
        }),
      );
    } else if (!req.writableNeedDrain) drained();
  });
}

type BodySource = {
  next(): Promise<Uint8Array | null>;
  stop(reason?: unknown): void | Promise<void>;
};

function foreignBodySource(body: ReadableStream<Uint8Array>): BodySource {
  const reader = body.getReader();
  return {
    next: async () => {
      const { done, value } = await reader.read();
      return done ? null : value;
    },
    stop: (reason) => {
      void reader.cancel(reason).catch(() => undefined);
      reader.releaseLock();
    },
  };
}

function cancelForeignBody(body: ReadableStream<Uint8Array> | null): void {
  if (body) void body.cancel().catch(() => undefined);
}

function nodeBodySource(res: IncomingMessage): BodySource {
  const iterator = res[Symbol.asyncIterator]();
  return {
    next: async () => {
      const { done, value } = await iterator.next();
      return done ? null : value;
    },
    stop: async () => {
      if (!res.destroyed) res.destroy();
      await iterator.return?.();
    },
  };
}

function demandAwareStream(
  source: BodySource,
  exchange: TransferExchange,
  cleanup: () => void | Promise<void>,
): ReadableStream<Uint8Array> {
  let ended = false;
  let finishing: Promise<void> | undefined;
  const finish = (reason?: unknown) => {
    if (finishing) return finishing;
    ended = true;
    exchange.signal.removeEventListener('abort', onAbort);
    exchange.watchdog.suspend();
    finishing = Promise.resolve(source.stop(reason))
      .catch(() => undefined)
      .then(cleanup);
    return finishing;
  };
  let downstream: ReadableStreamDefaultController<Uint8Array>;
  const onAbort = () => {
    if (ended) return;
    downstream.error(exchange.signal.reason);
    void finish(exchange.signal.reason);
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        downstream = controller;
        exchange.signal.addEventListener('abort', onAbort, { once: true });
        if (exchange.signal.aborted) onAbort();
      },
      async pull(controller) {
        if (ended) return;
        exchange.watchdog.arm('response-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
        try {
          for (;;) {
            const chunk = await untilAborted(exchange.signal, () => source.next());
            if (ended) return;
            if (chunk === null) {
              await finish();
              controller.close();
              return;
            }
            if (chunk.byteLength === 0) {
              await yieldTransferEvents(exchange.signal);
              continue;
            }
            exchange.watchdog.suspend();
            controller.enqueue(chunk);
            return;
          }
        } catch (error) {
          if (ended) return;
          const failure = exchange.classify(error);
          controller.error(failure);
          await finish(failure);
        }
      },
      cancel(reason) {
        exchange.cancel(reason);
        return finish(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

function yieldTransferEvents(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, 0);
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function untilAborted<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
  discardLate?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stop = () => {
      settled = true;
      signal.removeEventListener('abort', aborted);
    };
    const aborted = () => {
      stop();
      reject(signal.reason);
    };
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    try {
      run().then(
        (value) => {
          if (settled) {
            discardLate?.(value);
            return;
          }
          stop();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          stop();
          reject(error);
        },
      );
    } catch (error) {
      stop();
      reject(error);
    }
  });
}
