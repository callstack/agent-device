import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import net, { type Socket } from 'node:net';
import tls from 'node:tls';

/** The only application protocol this transport speaks, so it is the only one it offers at TLS. */
const HTTP_1_1_ALPN = 'http/1.1';

export type InstallSourceNetworkResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: NodeJS.ReadableStream;
  close: () => Promise<void>;
};

export async function requestApprovedUrl(params: {
  url: URL;
  approvedAddress: string;
  family: 4 | 6;
  headers: Record<string, string>;
  signal: AbortSignal;
  /** The host environment whose proxy variables apply to the request. */
  environment: NodeJS.ProcessEnv;
  /** Called once the upstream TCP connection or TLS session is established. */
  onConnected?: () => void;
}): Promise<InstallSourceNetworkResponse> {
  const { url, approvedAddress, signal } = params;
  signal.throwIfAborted();
  const hostname = stripBrackets(url.hostname);
  const secure = url.protocol === 'https:';
  const port = Number(url.port || (secure ? 443 : 80));
  const proxy = resolveProxyForUrl(url, params.environment);
  const authority =
    params.family === 6 ? `[${approvedAddress}]:${port}` : `${approvedAddress}:${port}`;
  const tunnel = proxy ? await connectThroughProxy(new URL(proxy), authority, signal) : undefined;
  const socket = secure
    ? tls.connect({
        ...(tunnel ? { socket: tunnel } : { host: approvedAddress, port }),
        ...(net.isIP(hostname) === 0 ? { servername: hostname } : {}),
        // The transport speaks HTTP/1.1 on the socket, so every TLS leg must offer it.
        ALPNProtocols: [HTTP_1_1_ALPN],
        checkServerIdentity: (_host, certificate) => tls.checkServerIdentity(hostname, certificate),
      })
    : (tunnel ?? net.connect({ host: approvedAddress, port }));
  let request: http.ClientRequest | undefined;
  let body: http.IncomingMessage | undefined;
  const onAbort = () => {
    const reason: unknown = signal.reason;
    const error =
      reason instanceof Error
        ? reason
        : new Error('Install source request aborted', {
            cause: reason,
          });
    if (body && !body.readableEnded) body.destroy(error);
    else if (!body && request) request.destroy(error);
    else if (!request) socket.destroy(error);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const close = async () => {
    signal.removeEventListener('abort', onAbort);
    body?.destroy();
    await Promise.all([closeSocket(socket), tunnel && tunnel !== socket && closeSocket(tunnel)]);
  };
  try {
    if (!tunnel || secure) await once(socket, secure ? 'secureConnect' : 'connect');
    signal.throwIfAborted();
    params.onConnected?.();
    // A connected socket (including a TLS socket) carries the request without a shared agent.
    request = http.request({
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: { ...params.headers, host: url.host, connection: 'close' },
      createConnection: () => socket,
    });
    const upstream = request;
    return await new Promise<InstallSourceNetworkResponse>((resolve, reject) => {
      upstream.on('error', (error) => {
        if (body) body.destroy(error);
        else reject(error);
      });
      upstream.once('response', (response) => {
        body = response;
        // The download can reject the response before attaching its body pipeline.
        response.on('error', () => {});
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headersDistinct,
          body: response,
          close,
        });
      });
      upstream.once('upgrade', () => reject(networkError('Unexpected upgrade response', 'EPROTO')));
      upstream.end();
    });
  } catch (error) {
    await close();
    throw error;
  }
}

async function connectThroughProxy(
  proxy: URL,
  authority: string,
  signal: AbortSignal,
): Promise<Socket> {
  const request = createProxyConnectRequest(proxy, authority);
  const onAbort = () => request.destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const connected = once(request, 'connect') as Promise<[http.IncomingMessage, Socket, Buffer]>;
    request.end();
    const [response, socket, head] = await connected;
    if (signal.aborted || response.statusCode !== 200) {
      await closeSocket(socket);
      signal.throwIfAborted();
      throw networkError(
        `Proxy response (${response.statusCode}) !== 200 when HTTP Tunneling`,
        'EPROXYTUNNEL',
      );
    }
    if (head.length) socket.unshift(head);
    return socket;
  } catch (error) {
    if (request.socket) await closeSocket(request.socket);
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function createProxyConnectRequest(proxy: URL, authority: string): http.ClientRequest {
  const secure = proxy.protocol === 'https:';
  if (!secure && proxy.protocol !== 'http:') {
    throw new Error('Unsupported install source proxy protocol');
  }
  const headers: Record<string, string> = { host: authority };
  if (proxy.username || proxy.password) {
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }
  const hostname = stripBrackets(proxy.hostname);
  return (secure ? https : http).request({
    hostname,
    port: Number(proxy.port || (secure ? 443 : 80)),
    method: 'CONNECT',
    path: authority,
    headers,
    agent: false,
    ...(secure
      ? { servername: net.isIP(hostname) ? '' : hostname, ALPNProtocols: [HTTP_1_1_ALPN] }
      : {}),
  });
}

function networkError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

async function closeSocket(socket: Socket): Promise<void> {
  if (socket.closed) return;
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));
  socket.destroy();
  await closed;
}

export function resolveProxyForUrl(url: URL, environment: NodeJS.ProcessEnv): string | undefined {
  const noProxy = environment.no_proxy ?? environment.NO_PROXY;
  if (matchesNoProxy(url, noProxy)) return undefined;
  const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY;
  if (url.protocol === 'http:') return httpProxy || undefined;
  const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY;
  return httpsProxy || httpProxy || undefined;
}

export function matchesNoProxy(url: URL, raw: string | undefined): boolean {
  if (!raw) return false;
  const hostname = stripBrackets(url.hostname).toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((token) => {
      if (token === '*') return true;
      const parsed = parseNoProxyToken(token);
      if (parsed.port && parsed.port !== port) return false;
      const suffix = parsed.hostname.replace(/^\*?\./, '').toLowerCase();
      return hostname === suffix || hostname.endsWith(`.${suffix}`);
    });
}

function parseNoProxyToken(token: string): { hostname: string; port?: string } {
  if (token.startsWith('[')) {
    const close = token.indexOf(']');
    if (close < 0) return { hostname: token };
    return {
      hostname: token.slice(1, close),
      port: token[close + 1] === ':' ? token.slice(close + 2) : undefined,
    };
  }
  const colon = token.lastIndexOf(':');
  if (colon > -1 && token.indexOf(':') === colon) {
    return { hostname: token.slice(0, colon), port: token.slice(colon + 1) };
  }
  return { hostname: token };
}

function stripBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}
