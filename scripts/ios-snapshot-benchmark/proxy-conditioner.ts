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

type RequestContext = {
  route: URL;
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
  let randomState = options.network.seed >>> 0;
  const server = http.createServer((request, response) => {
    void forwardRequest(request, response, options, records, () => {
      randomState = nextRandom(randomState);
      return randomState / 0x1_0000_0000;
    });
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
  options: { upstreamBaseUrl: string; network: ProxyNetwork },
  records: ProxyRpcRecord[],
  random: () => number,
): Promise<void> {
  const context = await readRequestContext(request, records);
  if (dropRequest(context, response, options.network, records, random)) return;
  await waitForNetwork(options.network, context.body.byteLength);
  try {
    await sendRequest(context, response, options, records);
  } catch (error) {
    writeUpstreamFailure(context, response, records, error);
  }
}

async function readRequestContext(
  request: IncomingMessage,
  records: ProxyRpcRecord[],
): Promise<RequestContext> {
  const route = new URL(request.url ?? '/', 'http://conditioner.invalid');
  const isRpc = route.pathname.endsWith('/rpc');
  return {
    route,
    method: request.method ?? 'GET',
    headers: request.headers,
    isRpc,
    sequence: isRpc ? records.length + 1 : 0,
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
  options: { upstreamBaseUrl: string; network: ProxyNetwork },
  records: ProxyRpcRecord[],
): Promise<void> {
  const upstream = await fetch(buildTargetUrl(options.upstreamBaseUrl, context.route), {
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
  error: unknown,
): void {
  if (context.isRpc) recordFailure(context, records);
  response.statusCode = 502;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
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

function buildTargetUrl(upstreamBaseUrl: string, route: URL): string {
  const base = new URL(upstreamBaseUrl);
  return new URL(`${route.pathname}${route.search}`, `${base.origin}/`).toString();
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
