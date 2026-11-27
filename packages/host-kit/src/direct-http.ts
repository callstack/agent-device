import type { Agent } from 'node:http';
import { loadNodeHttpRequester } from './internal/transport.ts';

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

/**
 * Sends one Fetch request over `node:http` with `loadDirectHttpAgent`, for a plain-http
 * destination that receives a credential. It never follows a redirect: a 3xx is returned as is.
 */
export async function fetchOverDirectHttp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== 'http:') throw new TypeError('fetchOverDirectHttp sends plain http only');
  const [http, agent, { Readable }] = await Promise.all([
    loadNodeHttpRequester('http:'),
    loadDirectHttpAgent('http:'),
    import('node:stream'),
  ]);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  request.signal.throwIfAborted();
  return await new Promise<Response>((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        agent,
        signal: request.signal,
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
        }
        const nullBody = request.method === 'HEAD' || NULL_BODY_STATUSES.has(status);
        if (nullBody) res.resume();
        resolve(
          new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            statusText: res.statusMessage,
            headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
