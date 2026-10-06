import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TLSSocket } from 'node:tls';
import { createDaemonProxy, type DaemonProxy, type DaemonProxyOptions } from './daemon-proxy.ts';

export function createDaemonProxyServer(options: DaemonProxyOptions): http.Server {
  return http.createServer(createDaemonProxyRequestListener(createDaemonProxy(options)));
}

/** Serves a proxy from any `node:http` or `node:https` server; upload tickets follow its scheme. */
export function createDaemonProxyRequestListener(proxy: DaemonProxy): http.RequestListener {
  return (req, res) => {
    void serveProxyRequest(proxy, req, res).catch((error: unknown) => {
      if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
    });
  };
}

async function serveProxyRequest(
  proxy: DaemonProxy,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = requestUrl(req);
  if (!url) {
    endWithStatus(res, 400);
    return;
  }
  let request: Request;
  try {
    request = toWebRequest(url, req, res);
  } catch {
    // Fetch refuses CONNECT, TRACE and TRACK; the daemon serves none of them.
    endWithStatus(res, 404);
    return;
  }
  const response = await proxy.handle(request);
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
}

function endWithStatus(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.end();
}

/** `null` when the Host header and path do not form a URL. */
function requestUrl(req: IncomingMessage): URL | null {
  const scheme = req.socket instanceof TLSSocket ? 'https' : 'http';
  return URL.parse(req.url ?? '/', `${scheme}://${req.headers.host ?? '127.0.0.1'}`);
}

function toWebRequest(url: URL, req: IncomingMessage, res: ServerResponse): Request {
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers: toWebHeaders(req),
    signal: clientGoneSignal(req, res),
    ...(hasBody
      ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' as const }
      : {}),
  });
}

function toWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

function clientGoneSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const clientGone = new AbortController();
  const abortIfResponseIncomplete = () => {
    if (res.writableFinished || clientGone.signal.aborted) return;
    clientGone.abort(new Error('Proxy client disconnected before the response ended'));
  };
  req.on('aborted', abortIfResponseIncomplete);
  res.on('close', abortIfResponseIncomplete);
  return clientGone.signal;
}
