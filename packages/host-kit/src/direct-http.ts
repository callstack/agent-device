import type { LookupAddress } from 'node:dns';
import type { Agent, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import type { Duplex, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  assertSecureCredentialTransport,
  credentialTransportRefusal,
  type CredentialTransportExceptions,
} from '@agent-device/contracts/credential-transport';
import { isLoopbackHostname } from '@agent-device/contracts/loopback-host';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';

// The one way a credential leaves this process over HTTP: `fetchWithCredential`, and the agent and
// lookup it shares with the `node:http` and WebSocket senders. Loaded at send time by the code that
// sends a credential, never at module scope.

/**
 * Resolves a name to loopback addresses only. `localhost` is the one name a plain-http credential
 * may name, and a resolver is free to answer it with any address.
 */
export const lookupLoopbackOnly: LookupFunction = (hostname, options, callback) => {
  void import('node:dns').then(({ default: dns }) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error, []);
      const loopback = addresses.filter(({ address }) => isLoopbackHostname(address));
      const [first] = loopback;
      if (!first) {
        const refusal = credentialTransportRefusal(
          'localhost resolves to no loopback address, so no credential is sent to it.',
        );
        return callback(refusal, []);
      }
      if (options.all) callback(null, loopback);
      else callback(null, first.address, first.family);
    });
  });
};

let directHttpAgent: Agent | undefined;

/**
 * The agent for a plain-http request that carries a credential: a direct connection that never
 * routes through an environment proxy (`NODE_USE_ENV_PROXY` with `HTTP_PROXY`), which would read
 * the credential in cleartext, and that connects a name only to a loopback address. A `fresh` agent
 * opens its own connection instead of reusing a pooled one.
 */
export async function loadDirectHttpAgent(fresh = false): Promise<Agent> {
  const http = (await import('node:http')).default;
  const options = { lookup: lookupLoopbackOnly };
  if (fresh) return new http.Agent(options);
  directHttpAgent ??= new http.Agent({
    ...options,
    keepAlive: true,
    scheduling: 'lifo',
    timeout: 5_000,
  });
  return directHttpAgent;
}

export const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

export function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

/** A `node:http` response's headers as Fetch `Headers`, repeated values kept in order. */
export function responseHeadersOf(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

// The silence `fetch` allows while it waits for response headers or the next body bytes. It
// replaces the agent's 5 s timeout, which is for pooled sockets and would end a long command.
const IDLE_TIMEOUT_MS = 300_000;

const DIRECT_HTTP_REASONS = {
  // A plain-http exchange with a loopback peer stayed silent for `details.timeoutMs`.
  idleTimeout: { reason: 'direct_http_idle_timeout' },
} as const satisfies ReasonTable<'remote connection'>;

type Decoding = {
  zlib: typeof import('node:zlib');
  Transform: typeof import('node:stream').Transform;
};

/** The decoders `fetch` applies for a `Content-Encoding`, or none when it names another coding. */
function contentDecoders(decoding: Decoding, encoding: string | null): Transform[] {
  const { zlib } = decoding;
  // Flushes what has arrived, so a streamed answer is readable as it comes.
  const options = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  const codings = (encoding ?? '').toLowerCase().split(',');
  const decoders = codings.reverse().map((coding) => {
    switch (coding.trim()) {
      case 'gzip':
      case 'x-gzip':
        return zlib.createGunzip(options);
      case 'deflate':
        return createDeflateDecoder(decoding, options);
      case 'br':
        return zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH });
      default:
        return undefined;
    }
  });
  return decoders.every((decoder) => decoder !== undefined) ? decoders : [];
}

/** `deflate` is zlib-wrapped by the standard and raw from some servers; the first byte tells. */
function createDeflateDecoder(
  { zlib, Transform }: Decoding,
  options: import('node:zlib').ZlibOptions,
): Transform {
  let inflate: import('node:zlib').Inflate | undefined;
  const decoder: Transform = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!inflate) {
        const wrapped = (chunk[0]! & 0x0f) === 0x08;
        inflate = wrapped ? zlib.createInflate(options) : zlib.createInflateRaw(options);
        inflate.on('data', (decoded) => decoder.push(decoded));
        inflate.on('error', (error) => decoder.destroy(error));
      }
      inflate.write(chunk, () => done());
    },
    flush(done) {
      if (!inflate) return done();
      inflate.once('end', () => done());
      inflate.end();
    },
  });
  return decoder;
}

/**
 * Sends one request over `node:http` with the direct agent. It never follows a redirect: a 3xx is
 * returned as is, or fails the request that asks for `redirect: 'error'`. As with `fetch`, a gzip,
 * deflate or br body is decoded, and a failed exchange rejects with `TypeError('fetch failed')`
 * carrying the cause, except a typed refusal, which rejects as itself. An abort ends the exchange
 * with the signal's reason, and five silent minutes end it with a `direct_http_idle_timeout` error:
 * the call rejects with it, or after the response, the body read does.
 *
 * `request`'s own body is read whole, so the request declares its length. A `streamedBody` is piped
 * instead, as it arrives, with the length the headers declare or else chunked.
 */
async function fetchOverDirectHttp(
  request: Request,
  streamedBody?: AsyncIterable<Uint8Array>,
): Promise<Response> {
  const url = new URL(request.url);
  // The module object itself, so a stubbed `request` is the one called.
  const [{ default: http }, agent, { Readable, Transform, pipeline }, zlib] = await Promise.all([
    import('node:http'),
    loadDirectHttpAgent(),
    import('node:stream'),
    import('node:zlib'),
  ]);
  // Taken over before anything can end the exchange, so that every way it fails releases it. A
  // stream is destroyed or cancelled even while a read is pending, which the return of an async
  // iterator over it would wait for.
  const source =
    streamedBody === undefined || streamedBody instanceof Readable
      ? streamedBody
      : streamedBody instanceof ReadableStream
        ? Readable.fromWeb(streamedBody as WebReadableStream<Uint8Array>)
        : Readable.from(streamedBody, { objectMode: false });
  source?.on('error', () => undefined);
  const exchange = () =>
    new Promise<Response>((resolve, reject) => {
      let response: IncomingMessage | undefined;
      const fail = (cause: unknown) =>
        reject(cause instanceof AppError ? cause : new TypeError('fetch failed', { cause }));
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
          if (request.redirect === 'error' && isRedirectStatus(status)) {
            res.destroy();
            fail(new Error('unexpected redirect'));
            return;
          }
          const nullBody = request.method === 'HEAD' || NULL_BODY_STATUSES.has(status);
          if (nullBody) res.resume();
          const headers = responseHeadersOf(res);
          const decoders = nullBody
            ? []
            : contentDecoders({ zlib, Transform }, headers.get('content-encoding'));
          let body: IncomingMessage | Duplex = res;
          if (decoders.length > 0) {
            headers.delete('content-encoding');
            headers.delete('content-length');
            body = decoders.at(-1)!;
            // Carries a failure or a cancellation between the socket and the reader.
            pipeline([res, ...decoders], () => undefined);
          }
          resolve(
            new Response(nullBody ? null : (Readable.toWeb(body) as ReadableStream<Uint8Array>), {
              status,
              statusText: res.statusMessage,
              headers,
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
      if (source) {
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
  try {
    request.signal.throwIfAborted();
    return await exchange();
  } catch (error) {
    source?.destroy();
    throw error;
  }
}

/** How many same-origin redirects a credential-bearing request follows. */
const MAX_FOLLOWED_REDIRECTS = 3;

export type CredentialSend = CredentialTransportExceptions & {
  /** Names the setting a refusal is about. */
  subject: string;
  /** The caller's own transport, which carries every request the rule admits. */
  send?: typeof fetch;
};

/**
 * Sends a request that carries a credential, and is the only way to send one with Fetch semantics.
 * Every URL it sends to meets the credential transport rule first. Plain http goes direct over
 * `node:http`, never through an environment proxy; https goes through global `fetch`; an injected
 * `send` replaces both.
 *
 * It never follows a redirect off the origin. A URL with `redirect: 'follow'`, the default, follows
 * up to three redirects on the same origin, keeping method and body on a 307 or 308; any other
 * redirect is returned as the answer. A `Request` is sent once.
 */
export async function fetchWithCredential(
  input: string | URL | Request,
  init: RequestInit,
  { subject, send, ...exceptions }: CredentialSend,
): Promise<Response> {
  const redirect = init.redirect ?? (input instanceof Request ? input.redirect : 'follow');
  let target = input;
  let hop = init;
  for (let followed = 0; ; followed += 1) {
    const url = assertSecureCredentialTransport(
      target instanceof Request ? target.url : target,
      subject,
      exceptions,
    );
    const next = { ...hop, redirect: redirect === 'error' ? redirect : ('manual' as const) };
    const response = await sendOnce(target, next, send);
    if (redirect !== 'follow' || target instanceof Request) return response;
    const followedTo =
      followed < MAX_FOLLOWED_REDIRECTS ? sameOriginHop(response, url, hop) : undefined;
    if (!followedTo) return response;
    await response.body?.cancel().catch(() => undefined);
    [target, hop] = followedTo;
  }
}

async function sendOnce(
  input: string | URL | Request,
  init: RequestInit,
  send: typeof fetch | undefined,
): Promise<Response> {
  if (send) return await send(input, init);
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== 'http:') return await fetch(input, init);
  const { body } = init;
  if (!isStreamedBody(body)) return await fetchOverDirectHttp(new Request(input, init));
  return await fetchOverDirectHttp(new Request(input, { ...init, body: null }), body);
}

/**
 * The URL and request a redirect on the same origin leads to, as `fetch` would send it, or
 * `undefined` for any other answer. A streamed body cannot be sent twice.
 */
function sameOriginHop(
  response: Response,
  from: URL,
  init: RequestInit,
): [URL, RequestInit] | undefined {
  if (!isRedirectStatus(response.status)) return undefined;
  const location = response.headers.get('location');
  if (location === null) return undefined;
  const url = URL.parse(location, from);
  if (!url || url.origin !== from.origin || url.username || url.password) return undefined;
  const method = (init.method ?? 'GET').toUpperCase();
  const becomesGet =
    response.status === 303
      ? method !== 'GET' && method !== 'HEAD'
      : response.status < 303 && method === 'POST';
  if (!becomesGet) return isStreamedBody(init.body) ? undefined : [url, init];
  const headers = new Headers(init.headers);
  for (const name of ['content-type', 'content-length', 'content-encoding']) headers.delete(name);
  return [url, { ...init, method: 'GET', body: null, headers }];
}

/** A body that arrives in pieces: a web or Node stream, or any other async iterable. */
function isStreamedBody(body: unknown): body is AsyncIterable<Uint8Array> {
  return typeof body === 'object' && body !== null && Symbol.asyncIterator in body;
}
