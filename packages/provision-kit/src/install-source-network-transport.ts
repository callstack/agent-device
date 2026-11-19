import net from 'node:net';
import { Agent, Pool, ProxyAgent, request, type Dispatcher } from 'undici';

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
  /** Called once the dispatcher's connection to the upstream is established. */
  onConnected?: () => void;
}): Promise<InstallSourceNetworkResponse> {
  const proxy = resolveProxyForUrl(params.url, params.environment);
  const dispatcher = proxy
    ? proxyDispatcher(proxy, params.url, params.onConnected)
    : directDispatcher(params.approvedAddress, params.family);
  const dispatchUrl = proxy
    ? approvedAddressUrl(params.url, params.approvedAddress, params.family)
    : params.url;
  // Only undici's Agent emits 'connect' (pinned undici 7.30.1: agent.js/client.js do, the
  // ProxyAgent dispatcher does not), so the proxy path reports establishment from inside its own
  // tunnel connector wrap instead of this event.
  if (!proxy && params.onConnected) dispatcher.once('connect', params.onConnected);
  try {
    const requestOptions = {
      dispatcher,
      headers: proxy ? { ...params.headers, host: params.url.host } : params.headers,
      maxRedirections: 0,
      method: 'GET' as const,
      signal: params.signal,
    };
    const response = await request(dispatchUrl, requestOptions);
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
      close: async () => await closeDispatcher(dispatcher),
    };
  } catch (error) {
    await closeDispatcher(dispatcher);
    throw error;
  } finally {
    if (!proxy && params.onConnected) dispatcher.off('connect', params.onConnected);
  }
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

function directDispatcher(address: string, family: 4 | 6): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
    },
  });
}

function proxyDispatcher(proxyUrl: string, destination: URL, onConnected?: () => void): ProxyAgent {
  const literalDestination = net.isIP(stripBrackets(destination.hostname)) !== 0;
  return new ProxyAgent({
    uri: proxyUrl,
    proxyTunnel: true,
    requestTls:
      destination.protocol === 'https:' && !literalDestination
        ? { servername: stripBrackets(destination.hostname) }
        : undefined,
    // ProxyAgent builds its own inner Agent and never emits 'connect' (pinned undici 7.30.1,
    // lib/dispatcher/proxy-agent.js), so establishment is reported by wrapping the tunnel
    // connector the inner factory receives: its callback fires exactly when the upstream
    // connection through the CONNECT tunnel is established.
    factory: (origin: string | URL, options: Pool.Options) =>
      new Pool(origin, withUpstreamConnectedCallback(options, onConnected)),
  });
}

type TunnelConnectCallback = (
  ...args: [error: null, socket: net.Socket] | [error: Error, socket: null]
) => void;
type TunnelConnect = (options: unknown, callback: TunnelConnectCallback) => void;

/** Fires `onConnected` once the wrapped connector has established the upstream connection. */
function withUpstreamConnectedCallback(
  options: Pool.Options,
  onConnected?: () => void,
): Pool.Options {
  const connect = options.connect;
  if (!onConnected || typeof connect !== 'function') return options;
  const tunnelConnect = connect as TunnelConnect;
  return {
    ...options,
    connect: (connectOptions: unknown, callback: TunnelConnectCallback) =>
      tunnelConnect(connectOptions, (...args) => {
        if (args[0] === null) onConnected();
        callback(...args);
      }),
  };
}

function approvedAddressUrl(original: URL, address: string, family: 4 | 6): URL {
  const approved = new URL(original);
  approved.hostname = family === 6 ? `[${stripBrackets(address)}]` : address;
  return approved;
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

async function closeDispatcher(dispatcher: Dispatcher): Promise<void> {
  await dispatcher.close();
}
