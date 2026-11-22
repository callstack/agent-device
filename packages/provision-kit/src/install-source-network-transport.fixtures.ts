import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import path from 'node:path';

import type { InstallSourceNetworkResponse } from './install-source-network-transport.ts';

/**
 * Loopback-only harness for the install-source transport.
 *
 * Every listener binds 127.0.0.1, so no case leaves the machine. Origin hostnames are reserved
 * bad names, so a request that reaches an origin proves the transport dialed the approved
 * address it was handed rather than resolving the name.
 */

/** Per-case budget: a stalled case must be cut short by the signal under test, not by Vitest. */
export const TRANSPORT_TEST_TIMEOUT_MS = 2_000;

/** Public test data for loopback HTTPS; the key is shared on purpose and is not a credential. */
const LOOPBACK_TLS_FIXTURE_PATHS = {
  cert: 'test/integration/provider-scenarios/fixtures/localhost-cert.pem',
  key: 'test/integration/provider-scenarios/fixtures/localhost-key.pem',
} as const;

export const APPROVED_HOSTNAME = 'approved.invalid';
export const APPROVED_ADDRESS = '127.0.0.1';
export const ARTIFACT_BODY = 'artifact';

const SETTLE_DEADLINE_MS = 700;
const SETTLE_POLL_MS = 20;

export type ObservedRequest = {
  method: string;
  url: string;
  host?: string;
  custom?: string;
};

/** The transport surface a characterization run measures. */
export type TransportSubject = {
  requestApprovedUrl(params: {
    url: URL;
    approvedAddress: string;
    family: 4 | 6;
    headers: Record<string, string>;
    signal: AbortSignal;
    environment: NodeJS.ProcessEnv;
  }): Promise<InstallSourceNetworkResponse>;
};

export type LoopbackLab = {
  originPort: number;
  tlsOriginPort: number;
  /** Reachable origin the proxy refuses to dial: a working tunnel would answer 200 here. */
  refusalPort: number;
  /** Origin that accepts a connection and never answers the request. */
  silentPort: number;
  /** Origin that sends headers plus one chunk and then stalls. */
  stallerPort: number;
  /** Reachable origin the proxy accepts for CONNECT and then never tunnels to. */
  stalledConnectPort: number;
  proxyPort: number;
  /** Counts recorded so far, to turn the lab's logs into per-case slices. */
  mark(): LabMark;
  /** The requests the origin served after `mark`. */
  requestsSince(mark: LabMark): ObservedRequest[];
  connectAuthoritiesSince(mark: LabMark): string[];
  /** Live proxy sockets created after `mark`, so one case cannot be charged for another's. */
  liveProxySocketsSince(mark: LabMark): number;
  /** Drops sockets the proxy still holds after a case that never settled. */
  dropProxySockets(): void;
  /**
   * Waits until the proxy holds no socket created after `mark`, bounded by SETTLE_DEADLINE_MS. A
   * socket an earlier case leaked is not waited for: it is already reported against that case.
   */
  settleSince(mark: LabMark): Promise<void>;
  close(): Promise<void>;
};

export type LabMark = {
  requests: number;
  connect: number;
  proxySockets: number[];
};

/**
 * The lab slice `observeRequest` reads: the per-case markers, what the origin and the proxy
 * recorded, and the proxy socket census. Any lab that answers these questions can be observed, so
 * each lab owns only the listeners its cases need.
 */
export type ObservationLab = Pick<
  LoopbackLab,
  | 'mark'
  | 'requestsSince'
  | 'connectAuthoritiesSince'
  | 'liveProxySocketsSince'
  | 'settleSince'
  | 'dropProxySockets'
>;

export function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, APPROVED_ADDRESS, () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

type TrackedSockets = {
  /** Id given to the most recent connection, used as a per-case census mark. */
  highestId(): number;
  /** Connections with an id above `since`, which is how a case counts only its own sockets. */
  liveSince(since: number): number;
  destroyAll(): void;
};

export function trackSockets(server: net.Server): TrackedSockets {
  const live = new Map<net.Socket, number>();
  let ids = 0;
  server.on('connection', (socket) => {
    ids += 1;
    live.set(socket, ids);
    socket.on('close', () => live.delete(socket));
    socket.on('error', () => {});
  });
  return {
    highestId: () => ids,
    liveSince: (since) => [...live.values()].filter((id) => id > since).length,
    destroyAll: () => {
      for (const socket of live.keys()) socket.destroy();
    },
  };
}

export function readTlsFixturePair(root: string): { key: Buffer; cert: Buffer } {
  return {
    key: fs.readFileSync(path.join(root, LOOPBACK_TLS_FIXTURE_PATHS.key)),
    cert: fs.readFileSync(path.join(root, LOOPBACK_TLS_FIXTURE_PATHS.cert)),
  };
}

/**
 * The ALPN protocols the loopback TLS listeners offer. A server that advertises nothing reports
 * `false` for every handshake whatever the client offered, so the origin can only evidence the
 * client's offer while it advertises the protocol the transport speaks.
 */
export const FIXTURE_ALPN_PROTOCOLS = ['http/1.1'];

export function createTlsArtifactOrigin(credentials: { key: Buffer; cert: Buffer }): tls.Server {
  return tls.createServer({ ...credentials, ALPNProtocols: FIXTURE_ALPN_PROTOCOLS }, (socket) => {
    socket.on('error', () => {});
    socket.once('data', () => {
      // Echoes the handshake facts the client must present: the URL host as SNI, and the
      // negotiated protocol, where an offer of none is reported as `false`.
      socket.end(
        `HTTP/1.1 200 OK\r\nx-sni: ${String(socket.servername)}\r\nx-alpn: ${String(
          socket.alpnProtocol,
        )}\r\ncontent-length: 4\r\n\r\nbody`,
      );
    });
  });
}

export function forwardConnect(port: number, clientSocket: Duplex, head: Buffer): void {
  const upstream = net.connect(port, APPROVED_ADDRESS, () => {
    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
}

/** One proxy listener of a lab: its tracked sockets and the number of proxies the lab runs. */
export type ProxyFixture = {
  server: net.Server;
  sockets: TrackedSockets;
};

/**
 * The lifecycle every loopback lab shares: the origin that serves the artifact, the TLS origin that
 * echoes its handshake, the proxy listeners the cases dial, and the per-case markers, slices,
 * socket census and settling over their logs. A lab supplies only the proxy listeners whose tunnel
 * behavior its cases exercise.
 */
export async function startLoopbackLabBase(params: {
  /** Loopback certificate fixtures live under this repository root. */
  root: string;
  proxies: () => ProxyFixture[];
  /** Tunnel requests the proxies recorded, in order, as `host:port` authorities. */
  connectAuthorities: () => string[];
}): Promise<LoopbackLabBase> {
  const { key, cert } = readTlsFixturePair(params.root);
  const requests: ObservedRequest[] = [];

  const origin = http.createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      host: request.headers.host,
      // Recorded only when present, so a case that names no custom header compares equal.
      ...(request.headers['x-custom'] === undefined
        ? {}
        : { custom: request.headers['x-custom'] as string }),
    });
    if (request.url === '/redirect') {
      response.writeHead(302, { location: 'http://cdn.invalid/final' });
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/octet-stream');
    response.setHeader('x-repeated', ['a', 'b']);
    response.setHeader('set-cookie', ['c=1', 'd=2']);
    response.setHeader('x-origin-host', request.headers.host ?? '');
    response.writeHead(200);
    response.end(ARTIFACT_BODY);
  });
  const originSockets = trackSockets(origin);
  const originPort = await listen(origin);

  const tlsOrigin = createTlsArtifactOrigin({ key, cert });
  const tlsSockets = trackSockets(tlsOrigin);
  const tlsOriginPort = await listen(tlsOrigin);

  const proxies = params.proxies();
  for (const proxy of proxies) await listen(proxy.server);

  return {
    originPort,
    tlsOriginPort,
    mark: () => ({
      requests: requests.length,
      connect: params.connectAuthorities().length,
      proxySockets: proxies.map((proxy) => proxy.sockets.highestId()),
    }),
    requestsSince: (mark) => requestsWithoutPorts(requests.slice(mark.requests)),
    connectAuthoritiesSince: (mark) =>
      authoritiesWithoutPorts(params.connectAuthorities().slice(mark.connect)),
    liveProxySocketsSince: (mark) =>
      proxies.reduce(
        (live, proxy, index) => live + proxy.sockets.liveSince(mark.proxySockets[index] ?? 0),
        0,
      ),
    settleSince: async (mark) => {
      const deadline = Date.now() + SETTLE_DEADLINE_MS;
      while (
        Date.now() < deadline &&
        proxies.some((proxy, index) => proxy.sockets.liveSince(mark.proxySockets[index] ?? 0) > 0)
      ) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      }
    },
    dropProxySockets: () => {
      for (const proxy of proxies) proxy.sockets.destroyAll();
    },
    close: async () => {
      for (const server of [origin, tlsOrigin, ...proxies.map((proxy) => proxy.server)]) {
        (server as Partial<http.Server>).closeAllConnections?.();
        server.close();
      }
      originSockets.destroyAll();
      tlsSockets.destroyAll();
      for (const proxy of proxies) proxy.sockets.destroyAll();
    },
  };
}

export type LoopbackLabBase = Omit<
  LoopbackLab,
  'refusalPort' | 'silentPort' | 'stallerPort' | 'stalledConnectPort' | 'proxyPort'
>;

export async function startLoopbackLab(root: string): Promise<LoopbackLab> {
  const connectAuthorities: string[] = [];
  const refusalPorts = new Set<number>();
  const stalledConnectPorts = new Set<number>();

  const proxy = http.createServer((_request, response) => {
    response.writeHead(501).end();
  });
  proxy.on('connect', (request, clientSocket, head) => {
    const authority = request.url ?? '';
    connectAuthorities.push(authority);
    const port = Number(authority.split(':').at(-1));
    if (stalledConnectPorts.has(port)) {
      clientSocket.once('end', () => clientSocket.destroy());
      clientSocket.resume();
      return;
    }
    if (refusalPorts.has(port)) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n');
      clientSocket.end();
      return;
    }
    forwardConnect(port, clientSocket, head);
  });

  const base = await startLoopbackLabBase({
    root,
    proxies: () => [{ server: proxy, sockets: trackSockets(proxy) }],
    connectAuthorities: () => connectAuthorities,
  });

  // Reachable origin the proxy refuses for CONNECT: a working tunnel would answer 200 here, so a
  // refusal that reaches it would prove the transport dialed around the proxy.
  const refusal = http.createServer((_request, response) => {
    response.writeHead(200);
    response.end('refused-origin-was-reached');
  });
  const refusalSockets = trackSockets(refusal);
  const refusalPort = await listen(refusal);
  refusalPorts.add(refusalPort);

  const silent = http.createServer(() => {});
  const silentSockets = trackSockets(silent);
  const silentPort = await listen(silent);

  const staller = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('partial-chunk');
  });
  const stallerSockets = trackSockets(staller);
  const stallerPort = await listen(staller);

  // Reachable origin used only for the stalled-CONNECT case: dialing it directly answers 200, so
  // a response there would prove the tunnel was built when the proxy is meant to swallow it.
  const stalledConnect = http.createServer((_request, response) => {
    response.writeHead(200);
    response.end('stalled-connect-origin-was-reached');
  });
  const stalledConnectSockets = trackSockets(stalledConnect);
  const stalledConnectPort = await listen(stalledConnect);
  stalledConnectPorts.add(stalledConnectPort);

  return {
    ...base,
    refusalPort,
    silentPort,
    stallerPort,
    stalledConnectPort,
    proxyPort: (proxy.address() as net.AddressInfo).port,
    close: async () => {
      await base.close();
      for (const server of [refusal, silent, staller, stalledConnect]) {
        (server as http.Server).closeAllConnections?.();
        server.close();
      }
      refusalSockets.destroyAll();
      silentSockets.destroyAll();
      stallerSockets.destroyAll();
      stalledConnectSockets.destroyAll();
    },
  };
}

export function directEnvironment(): NodeJS.ProcessEnv {
  return { no_proxy: '*' };
}

export function proxiedEnvironment(proxyPort: number): NodeJS.ProcessEnv {
  return {
    http_proxy: `http://${APPROVED_ADDRESS}:${proxyPort}`,
    https_proxy: `http://${APPROVED_ADDRESS}:${proxyPort}`,
  };
}

export function noProxyEnvironment(proxyPort: number, hostname: string): NodeJS.ProcessEnv {
  return { ...proxiedEnvironment(proxyPort), no_proxy: hostname };
}

type TransportOutcome = 'response' | 'rejection' | 'stream-interrupted' | 'hung';

type TransportObservation = {
  outcome: TransportOutcome;
  statusCode?: number;
  body?: string;
  headers?: Record<string, string[]>;
  /** Requests the origin served, with ephemeral ports removed. */
  originSaw?: ObservedRequest[];
  connectAuthorities?: string[];
  /** Proxy sockets this case created that its own close left alive. */
  liveProxySockets?: number;
  error?: ErrorShape;
  /** One entry per `close()` call: `'ok'`, or the error shape that call rejected with. */
  closeResults?: ('ok' | ErrorShape)[];
};

export type ErrorShape = {
  name?: string;
  code?: string | number;
  message?: string;
  causeName?: string;
  causeCode?: string | number;
  causeMessage?: string;
};

export function errorShape(error: unknown): ErrorShape {
  const shaped = error as
    | (Error & {
        code?: string | number;
        cause?: Error & { code?: string | number };
      })
    | null;
  const defined = (entries: [string, string | number | undefined][]): ErrorShape =>
    Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as ErrorShape;
  return defined([
    ['name', shaped?.name],
    ['code', shaped?.code],
    ['message', shaped?.message],
    ['causeName', shaped?.cause?.name],
    ['causeCode', shaped?.cause?.code],
    ['causeMessage', shaped?.cause?.message],
  ]);
}

function selectedResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string[]> {
  const selected: Record<string, string[]> = {};
  for (const name of [
    'content-type',
    'x-repeated',
    'set-cookie',
    'x-origin-host',
    'x-sni',
    'x-alpn',
    'location',
  ]) {
    const value = headers[name];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    selected[name] = name === 'x-origin-host' ? values.map(withoutPort) : values;
  }
  return selected;
}

export function approvedUrl(port: number, pathname = '/app.zip'): URL {
  return new URL(`http://${APPROVED_HOSTNAME}:${port}${pathname}`);
}

/**
 * Runs one request through the subject and reports what happened instead of throwing: the
 * response shape, the read result, the result of each `close()` call, and the proxy socket census
 * after cleanup.
 *
 * Bound each transport operation independently and inspect sockets after the first close.
 * Call close again to check that cleanup is idempotent.
 */
export async function observeRequest(
  subject: TransportSubject,
  params: {
    url: URL;
    approvedAddress?: string;
    headers?: Record<string, string>;
    signal: AbortSignal;
    environment: NodeJS.ProcessEnv;
    lab: ObservationLab;
    readBody?: 'none';
    caseDeadlineMs?: number;
  },
): Promise<TransportObservation> {
  const deadline = params.caseDeadlineMs ?? TRANSPORT_TEST_TIMEOUT_MS + 500;
  type Step<T> = { kind: 'ok'; value: T } | { kind: 'failed'; error: unknown } | { kind: 'hung' };
  const withinDeadline = async <T>(work: Promise<T>): Promise<Step<T>> => {
    return await Promise.race([
      work.then(
        (value) => ({ kind: 'ok', value }) as Step<T>,
        (error: unknown) => ({ kind: 'failed', error }) as Step<T>,
      ),
      new Promise<Step<T>>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: 'hung' }), deadline);
        timer.unref?.();
      }),
    ]);
  };

  const mark = params.lab.mark();
  const closeResults: ('ok' | ErrorShape)[] = [];

  const hang = async (): Promise<TransportObservation> => {
    await params.lab.settleSince(mark);
    const observation = {
      outcome: 'hung' as const,
      connectAuthorities: params.lab.connectAuthoritiesSince(mark),
      liveProxySockets: params.lab.liveProxySocketsSince(mark),
      closeResults,
    };
    // The case reports the socket it left behind; the lab then drops it so the next case's
    // census measures that case's own cleanup.
    params.lab.dropProxySockets();
    await params.lab.settleSince(mark);
    return observation;
  };

  const started = await withinDeadline(
    subject.requestApprovedUrl({
      url: params.url,
      approvedAddress: params.approvedAddress ?? APPROVED_ADDRESS,
      family: 4,
      headers: params.headers ?? {},
      signal: params.signal,
      environment: params.environment,
    }),
  );
  if (started.kind === 'hung') return await hang();
  if (started.kind === 'failed') {
    await params.lab.settleSince(mark);
    return {
      outcome: 'rejection',
      connectAuthorities: params.lab.connectAuthoritiesSince(mark),
      liveProxySockets: params.lab.liveProxySocketsSince(mark),
      closeResults,
      error: errorShape(started.error),
    };
  }
  const response = started.value;
  const closeOnce = async () => {
    try {
      await response.close();
      closeResults.push('ok');
    } catch (error) {
      closeResults.push(errorShape(error));
    }
  };

  let body = '';
  let readError: ErrorShape | undefined;
  if (params.readBody !== 'none') {
    const read = await withinDeadline(readStream(response.body));
    if (read.kind === 'hung') {
      await closeOnce();
      return { ...(await hang()), closeResults };
    }
    if (read.kind === 'ok') {
      body = read.value.body;
      readError = read.value.error;
    } else {
      readError = errorShape(read.error);
    }
  }

  await closeOnce();
  await params.lab.settleSince(mark);
  const liveProxySockets = params.lab.liveProxySocketsSince(mark);
  await closeOnce();
  await params.lab.settleSince(mark);
  return {
    outcome: readError ? 'stream-interrupted' : 'response',
    statusCode: response.statusCode,
    body,
    headers: selectedResponseHeaders(response.headers),
    originSaw: params.lab.requestsSince(mark),
    connectAuthorities: params.lab.connectAuthoritiesSince(mark),
    liveProxySockets,
    error: readError,
    closeResults,
  };
}

async function readStream(
  body: NodeJS.ReadableStream,
): Promise<{ body: string; error?: ErrorShape }> {
  const iterable = body as AsyncIterable<Uint8Array>;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of iterable) {
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    return { body: Buffer.concat(chunks).toString('utf8'), error: errorShape(error) };
  }
  return { body: Buffer.concat(chunks).toString('utf8') };
}

/** Signal aborted with an operator reason after a bounded delay. */
export function operatorAbortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('operator stop')), ms);
  timer.unref?.();
  return controller.signal;
}

/** Drops ephemeral ports from what the origin recorded so an observation is stable to compare. */
export function requestsWithoutPorts(requests: ObservedRequest[]): ObservedRequest[] {
  return requests.map((request) => ({
    ...request,
    url: withoutPort(request.url),
    host: request.host === undefined ? undefined : withoutPort(request.host),
  }));
}

/** Drops the ephemeral port from a CONNECT authority so an observation is stable to compare. */
export function authoritiesWithoutPorts(authorities: string[]): string[] {
  return authorities.map(withoutPort);
}

function withoutPort(value: string): string {
  return value.replaceAll(/:\d+/g, ':<port>');
}
