import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TLSSocket } from 'node:tls';
import type { DaemonProxy } from './daemon-proxy.ts';

export async function serveProxyRequest(
  proxy: DaemonProxy,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Fetch refuses TRACE. node:http rejects TRACK and routes CONNECT to the 'connect' event.
  if (req.method === 'TRACE') {
    endWithStatus(res, 404);
    return;
  }
  const url = requestUrl(req);
  if (!url) {
    endWithStatus(res, 400);
    return;
  }
  const response = await proxy.handle(toWebRequest(url, req, res));
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

/** `null` when the Host header and path do not form a URL that Fetch accepts. */
function requestUrl(req: IncomingMessage): URL | null {
  const scheme = req.socket instanceof TLSSocket ? 'https' : 'http';
  const url = URL.parse(req.url ?? '/', `${scheme}://${req.headers.host ?? '127.0.0.1'}`);
  if (!url || url.username || url.password) return null;
  return url;
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
  if (res.closed) abortIfResponseIncomplete();
  return clientGone.signal;
}
