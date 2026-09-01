import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProxyNetwork } from './types.ts';

export type ProxyRpcRecord = {
  sequence: number;
  requestBytes: number;
  responseBytes: number;
  status: number;
  failed: boolean;
};

export type NetworkConditioner = {
  baseUrl: string;
  network: ProxyNetwork;
  mark(): number;
  recordsSince(mark: number): ProxyRpcRecord[];
  close(): Promise<void>;
};

const UPSTREAM_FAILURE_BODY = JSON.stringify({ error: 'upstream request failed' });
const RPC_PATH = '/agent-device/rpc';
const HEALTH_PATH = '/agent-device/health';

type ConditionerPath = typeof RPC_PATH | typeof HEALTH_PATH;

type RequestContext = {
  path: ConditionerPath;
  method: string;
  headers: IncomingMessage['headers'];
  isRpc: boolean;
  sequence: number;
  body: Buffer;
};

export async function createNetworkConditioner(options: {
  upstreamBaseUrl: string;
  network: ProxyNetwork;
}): Promise<NetworkConditioner> {
  const records: ProxyRpcRecord[] = [];
  const upstreamPort = readLocalUpstreamPort(options.upstreamBaseUrl);
  let randomState = options.network.seed >>> 0;
  const server = http.createServer((request, response) => {
    void forwardRequest(
      request,
      response,
      { upstreamPort, network: options.network },
      records,
      () => {
        randomState = nextRandom(randomState);
        return randomState / 0x1_0000_0000;
      },
    );
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Network conditioner did not bind to a TCP address.');
  }
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    network: options.network,
    mark: () => records.length,
    recordsSince: (mark) => records.slice(mark).map((record) => ({ ...record })),
    close: () => closeServer(server),
  };
}

async function forwardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: { upstreamPort: string; network: ProxyNetwork },
  records: ProxyRpcRecord[],
  random: () => number,
): Promise<void> {
  const context = await readRequestContext(request, records);
  if (!context) {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }
  if (dropRequest(context, response, options.network, records, random)) return;
  await waitForNetwork(options.network, context.body.byteLength);
  try {
    await sendRequest(context, response, options, records);
  } catch {
    writeUpstreamFailure(context, response, records);
  }
}

async function readRequestContext(
  request: IncomingMessage,
  records: ProxyRpcRecord[],
): Promise<RequestContext | null> {
  const requestUrl = new URL(request.url ?? '/', 'http://conditioner.invalid');
  const path = resolveConditionerPath(requestUrl);
  if (!path) return null;
  return {
    path,
    method: request.method ?? 'GET',
    headers: request.headers,
    isRpc: path === RPC_PATH,
    sequence: path === RPC_PATH ? records.length + 1 : 0,
    body: await readBody(request),
  };
}

function dropRequest(
  context: RequestContext,
  response: ServerResponse,
  network: ProxyNetwork,
  records: ProxyRpcRecord[],
  random: () => number,
): boolean {
  if (!isDropped(network.packetLossPercent, random)) return false;
  if (context.isRpc) recordFailure(context, records);
  response.destroy();
  return true;
}

async function sendRequest(
  context: RequestContext,
  response: ServerResponse,
  options: { upstreamPort: string; network: ProxyNetwork },
  records: ProxyRpcRecord[],
): Promise<void> {
  const upstream = await fetch(buildTargetUrl(options.upstreamPort, context.path), {
    method: context.method,
    headers: forwardHeaders(context.headers),
    ...(context.body.byteLength > 0 ? { body: context.body, duplex: 'half' } : {}),
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  await waitForNetwork(options.network, body.byteLength);
  response.statusCode = upstream.status;
  copyHeader(response, 'content-type', upstream);
  copyHeader(response, 'x-request-id', upstream);
  if (context.isRpc) {
    records.push({
      sequence: context.sequence,
      requestBytes: context.body.byteLength,
      responseBytes: body.byteLength,
      status: upstream.status,
      failed: !upstream.ok,
    });
  }
  response.end(body);
}

function writeUpstreamFailure(
  context: RequestContext,
  response: ServerResponse,
  records: ProxyRpcRecord[],
): void {
  if (context.isRpc) recordFailure(context, records);
  response.statusCode = 502;
  response.setHeader('content-type', 'application/json');
  response.end(UPSTREAM_FAILURE_BODY);
}

function recordFailure(context: RequestContext, records: ProxyRpcRecord[]): void {
  records.push({
    sequence: context.sequence,
    requestBytes: context.body.byteLength,
    responseBytes: 0,
    status: 0,
    failed: true,
  });
}

function copyHeader(response: ServerResponse, name: string, upstream: Response): void {
  const value = upstream.headers.get(name);
  if (value) response.setHeader(name, value);
}

function buildTargetUrl(upstreamPort: string, path: ConditionerPath): string {
  const upstreamPath = path === RPC_PATH ? RPC_PATH : HEALTH_PATH;
  return `http://127.0.0.1:${upstreamPort}${upstreamPath}`;
}

function resolveConditionerPath(requestUrl: URL): ConditionerPath | undefined {
  if (requestUrl.search.length > 0) return undefined;
  if (requestUrl.pathname === RPC_PATH) return RPC_PATH;
  if (requestUrl.pathname === HEALTH_PATH) return HEALTH_PATH;
  return undefined;
}

function readLocalUpstreamPort(upstreamBaseUrl: string): string {
  const base = new URL(upstreamBaseUrl);
  const validBase = [
    base.protocol === 'http:',
    base.hostname === '127.0.0.1',
    base.port.length > 0,
    base.username.length === 0,
    base.password.length === 0,
    base.pathname === '/',
    base.search.length === 0,
    base.hash.length === 0,
  ].every(Boolean);
  if (!validBase) {
    throw new Error('Network conditioner upstream must be an HTTP 127.0.0.1 URL with a port.');
  }
  const port = Number(base.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Network conditioner upstream port must be between 1 and 65535.');
  }
  return String(port);
}

function forwardHeaders(headers: IncomingMessage['headers']): Headers {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      ['connection', 'content-length', 'host', 'transfer-encoding'].includes(name)
    ) {
      continue;
    }
    forwarded.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return forwarded;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function waitForNetwork(network: ProxyNetwork, bytes: number): Promise<void> {
  const bandwidthDelay = network.bandwidthKbps ? (bytes * 8) / network.bandwidthKbps : 0;
  const totalDelay = network.rttMs / 2 + bandwidthDelay;
  if (totalDelay > 0) await delay(totalDelay);
}

function isDropped(packetLossPercent: number, random: () => number): boolean {
  return packetLossPercent > 0 && random() * 100 < packetLossPercent;
}

function nextRandom(value: number): number {
  return (value * 1_664_525 + 1_013_904_223) >>> 0;
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
