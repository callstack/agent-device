import type { Agent, IncomingMessage } from 'node:http';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';

// Loaded at send time by the code that sends a credential over plain http, never at module scope.

let directHttpAgent: Agent | undefined;

/**
 * The agent for a plain-http request that carries a credential: a direct connection that never
 * routes through an environment proxy (`NODE_USE_ENV_PROXY` with `HTTP_PROXY`). Plain http
 * carries credentials only to loopback, and a proxy on another host would read them in cleartext.
 * Returns `undefined` for https, which keeps the default agent.
 */
export async function loadDirectHttpAgent(protocol: string): Promise<Agent | undefined> {
  if (protocol !== 'http:') return undefined;
  const http = (await import('node:http')).default;
  directHttpAgent ??= new http.Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5_000 });
  return directHttpAgent;
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** A `node:http` response's headers as Fetch `Headers`, repeated values kept in order. */
export function responseHeadersOf(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// The silence `fetch` allows while it waits for response headers or the next body bytes. It
// replaces the agent's 5 s timeout, which is for pooled sockets and would end a long command.
const IDLE_TIMEOUT_MS = 300_000;

const DIRECT_HTTP_REASONS = {
  // A plain-http exchange with a loopback peer stayed silent for `details.timeoutMs`.
  idleTimeout: { reason: 'direct_http_idle_timeout' },
} as const satisfies ReasonTable<'remote connection'>;

/**
 * Sends one Fetch request over `node:http` with `loadDirectHttpAgent`, for a plain-http
 * destination that receives a credential. It never follows a redirect: a 3xx is returned as is, or
 * fails the request that asks for `redirect: 'error'`. As with `fetch`, a failed exchange rejects
 * with `TypeError('fetch failed')` carrying the cause. An abort ends the exchange with the signal's
 * reason, and five silent minutes end it with a `direct_http_idle_timeout` error: the call rejects
 * with it, or after the response, the body read does.
 *
 * `request`'s own body is read whole, so the request declares its length. A `streamedBody` is piped
 * instead, as it arrives, with the length the headers declare or else chunked.
 */
export async function fetchOverDirectHttp(
  request: Request,
  streamedBody?: AsyncIterable<Uint8Array>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== 'http:') throw new TypeError('fetchOverDirectHttp sends plain http only');
  // The module object itself, so a stubbed `request` is the one called.
  const [{ default: http }, agent, { Readable }] = await Promise.all([
    import('node:http'),
    loadDirectHttpAgent('http:'),
    import('node:stream'),
  ]);
  request.signal.throwIfAborted();
  return await new Promise<Response>((resolve, reject) => {
    let response: IncomingMessage | undefined;
    const fail = (cause: unknown) => reject(new TypeError('fetch failed', { cause }));
    const end = (reason: Error) => {
      reject(reason);
      response?.destroy(reason);
      req.destroy();
    };
    const req = http.request(
      {
        host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        agent,
        timeout: IDLE_TIMEOUT_MS,
      },
      (res) => {
        response = res;
        // The body stream reports an error to its reader; an unread body has no other listener.
        res.on('error', () => undefined);
        const status = res.statusCode ?? 502;
        if (request.redirect === 'error' && REDIRECT_STATUSES.has(status)) {
          res.destroy();
          fail(new Error('unexpected redirect'));
          return;
        }
        const nullBody = request.method === 'HEAD' || NULL_BODY_STATUSES.has(status);
        if (nullBody) res.resume();
        resolve(
          new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            statusText: res.statusMessage,
            headers: responseHeadersOf(res),
          }),
        );
      },
    );
    req.on('timeout', () => {
      end(
        new AppError('COMMAND_FAILED', 'Plain-http request timed out waiting for the peer', {
          reason: DIRECT_HTTP_REASONS.idleTimeout.reason,
          timeoutMs: IDLE_TIMEOUT_MS,
        }),
      );
    });
    const abort = () => end(request.signal.reason as Error);
    request.signal.addEventListener('abort', abort, { once: true });
    // This listener also keeps `request` reachable while the exchange lives: its signal follows
    // the caller's only that long.
    req.once('close', () => request.signal.removeEventListener('abort', abort));
    req.on('error', fail);
    if (streamedBody) {
      // A stream is destroyed or cancelled even while a read is pending, which the return of an
      // async iterator over it would wait for.
      const source =
        streamedBody instanceof Readable
          ? streamedBody
          : streamedBody instanceof ReadableStream
            ? Readable.fromWeb(streamedBody as WebReadableStream<Uint8Array>)
            : Readable.from(streamedBody, { objectMode: false });
      source.on('error', (error) => {
        fail(error);
        req.destroy();
      });
      // Releases the source, and the file behind it, when the exchange ends first.
      req.once('close', () => source.destroy());
      source.pipe(req);
      return;
    }
    if (!request.body) {
      req.end();
      return;
    }
    request.arrayBuffer().then(
      (body) => req.end(Buffer.from(body)),
      (error: unknown) => {
        fail(error);
        req.destroy();
      },
    );
  });
}

/**
 * Sends one credential-bearing Fetch request. Plain http goes direct through
 * `fetchOverDirectHttp`, so an environment proxy never reads the credential in cleartext; anything
 * else goes through global `fetch`. The caller has already applied the credential transport rule.
 * An injected `send` is the caller's own transport and carries every request.
 */
export async function fetchWithCredential(
  input: string | URL,
  init: RequestInit = {},
  send?: typeof fetch,
): Promise<Response> {
  if (send) return await send(input, init);
  if (new URL(input).protocol !== 'http:') return await fetch(input, init);
  const { body } = init;
  if (!isStreamedBody(body)) return await fetchOverDirectHttp(new Request(input, init));
  return await fetchOverDirectHttp(new Request(input, { ...init, body: null }), body);
}

/** A body that arrives in pieces: a web or Node stream, or any other async iterable. */
function isStreamedBody(body: unknown): body is AsyncIterable<Uint8Array> {
  return typeof body === 'object' && body !== null && Symbol.asyncIterator in body;
}
