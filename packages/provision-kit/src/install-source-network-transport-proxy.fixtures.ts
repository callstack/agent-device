import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';

import { runTransportChild } from './install-source-network-transport-tls.fixtures.ts';
import {
  APPROVED_ADDRESS,
  APPROVED_HOSTNAME,
  ARTIFACT_BODY,
  authoritiesWithoutPorts,
  createTlsArtifactOrigin,
  errorShape,
  forwardConnect,
  listen,
  readTlsFixturePair,
  requestsWithoutPorts,
  trackSockets,
  type ErrorShape,
  type ObservedRequest,
  type TransportSubject,
} from './install-source-network-transport.fixtures.ts';

/**
 * Loopback-only lab for the proxy-scheme and proxy-authentication contract of the install-source
 * transport (#4674 evidence). Every listener binds 127.0.0.1, so no case leaves the machine, and
 * the origin hostname is a reserved bad name, so a request that reaches an origin proves the
 * transport dialed the approved address it was handed.
 *
 * Both lab proxies speak CONNECT and demand one synthetic fixture-only Basic credential; a real
 * credential is never used, read from the environment, or logged. The `https` proxy wraps the same
 * CONNECT exchange in TLS with the loopback fixture certificate, which the client side trusts only
 * when a spawned child is given that certificate as an extra CA.
 */

/** Synthetic fixture-only proxy credential. Not a real credential; only this lab accepts it. */
const PROXY_FIXTURE_USER = 'fixture-only-user';
/** Synthetic fixture-only proxy credential. Not a real credential; only this lab accepts it. */
const PROXY_FIXTURE_PASSWORD = 'fixture-only-secret';

/** The exact `Proxy-Authorization` value the lab proxies demand on CONNECT. */
export const EXPECTED_PROXY_AUTHORIZATION = `Basic ${Buffer.from(
  `${PROXY_FIXTURE_USER}:${PROXY_FIXTURE_PASSWORD}`,
  'utf8',
).toString('base64')}`;

/** The proxy URL handed to the transport through the proxy environment variables. */
export function authProxyUrl(scheme: 'http' | 'https', port: number): string {
  return `${scheme}://${PROXY_FIXTURE_USER}:${PROXY_FIXTURE_PASSWORD}@${APPROVED_ADDRESS}:${port}`;
}

/** Environment selecting the authenticating loopback HTTP proxy for both URL schemes. */
export function authHttpProxyEnvironment(proxyPort: number): NodeJS.ProcessEnv {
  const proxy = authProxyUrl('http', proxyPort);
  return { http_proxy: proxy, https_proxy: proxy };
}

type ProxyAuthLabMark = {
  requests: number;
  connect: number;
  proxySni: number;
  plainProxySockets: number;
  tlsProxySockets: number;
};

export type ProxyAuthLab = {
  originPort: number;
  tlsOriginPort: number;
  /** Plain-HTTP CONNECT proxy demanding the fixture credential. */
  proxyPort: number;
  /** TLS CONNECT proxy demanding the fixture credential, for the `https` proxy scheme. */
  tlsProxyPort: number;
  mark(): ProxyAuthLabMark;
  requestsSince(mark: ProxyAuthLabMark): ObservedRequest[];
  connectAuthoritiesSince(mark: ProxyAuthLabMark): string[];
  proxyAuthorizationsSince(mark: ProxyAuthLabMark): (string | undefined)[];
  /** The SNI names the TLS proxy accepted at its handshakes, after `mark`. */
  proxySniSince(mark: ProxyAuthLabMark): (string | undefined)[];
  liveProxySocketsSince(mark: ProxyAuthLabMark): number;
  settleSince(mark: ProxyAuthLabMark): Promise<void>;
  dropProxySockets(): void;
  close(): Promise<void>;
};

const SETTLE_DEADLINE_MS = 700;
const SETTLE_POLL_MS = 20;

/** One CONNECT exchange: demand the fixture credential, then tunnel to the approved address. */
function handleConnect(
  record: { authorities: string[]; authorizations: (string | undefined)[] },
  request: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
): void {
  const authority = request.url ?? '';
  record.authorities.push(authority);
  record.authorizations.push(request.headers['proxy-authorization']);
  if (request.headers['proxy-authorization'] !== EXPECTED_PROXY_AUTHORIZATION) {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n');
    clientSocket.end();
    return;
  }
  const port = Number(authority.split(':').at(-1));
  forwardConnect(port, clientSocket, head);
}

export async function startProxyAuthLab(root: string): Promise<ProxyAuthLab> {
  const { key, cert } = readTlsFixturePair(root);
  const requests: ObservedRequest[] = [];
  const proxySni: (string | undefined)[] = [];
  const record = { authorities: [] as string[], authorizations: [] as (string | undefined)[] };

  const origin = http.createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      host: request.headers.host,
    });
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(ARTIFACT_BODY);
  });
  const originPort = await listen(origin);

  const tlsOrigin = createTlsArtifactOrigin({ key, cert });
  const tlsOriginPort = await listen(tlsOrigin);

  const proxy = http.createServer((_request, response) => {
    response.writeHead(501).end();
  });
  proxy.on('connect', (request, clientSocket, head) =>
    handleConnect(record, request, clientSocket, head),
  );
  const proxySockets = trackSockets(proxy);
  const proxyPort = await listen(proxy);

  // The same CONNECT proxy behind TLS: an `https://` proxy URL must reach this listener.
  const tlsProxyServer = https.createServer({ key, cert }, (_request, response) => {
    response.writeHead(501).end();
  });
  tlsProxyServer.on('connect', (request, clientSocket, head) =>
    handleConnect(record, request, clientSocket, head),
  );
  tlsProxyServer.on('tlsClientError', () => {});
  // Records the name each client asked for at the handshake, so a case can prove the proxy dial
  // presented the proxy host as SNI. A handshake without SNI records `undefined`.
  tlsProxyServer.on('secureConnection', (socket) =>
    proxySni.push(typeof socket.servername === 'string' ? socket.servername : undefined),
  );
  const tlsProxySockets = trackSockets(tlsProxyServer);
  const tlsProxyPort = await listen(tlsProxyServer);

  return {
    originPort,
    tlsOriginPort,
    proxyPort,
    tlsProxyPort,
    mark: () => ({
      requests: requests.length,
      connect: record.authorities.length,
      proxySni: proxySni.length,
      plainProxySockets: proxySockets.highestId(),
      tlsProxySockets: tlsProxySockets.highestId(),
    }),
    requestsSince: (mark) => requestsWithoutPorts(requests.slice(mark.requests)),
    connectAuthoritiesSince: (mark) =>
      authoritiesWithoutPorts(record.authorities.slice(mark.connect)),
    proxyAuthorizationsSince: (mark) => record.authorizations.slice(mark.connect),
    proxySniSince: (mark) => proxySni.slice(mark.proxySni),
    liveProxySocketsSince: (mark) =>
      proxySockets.liveSince(mark.plainProxySockets) +
      tlsProxySockets.liveSince(mark.tlsProxySockets),
    settleSince: async (mark) => {
      const deadline = Date.now() + SETTLE_DEADLINE_MS;
      while (
        Date.now() < deadline &&
        (proxySockets.liveSince(mark.plainProxySockets) > 0 ||
          tlsProxySockets.liveSince(mark.tlsProxySockets) > 0)
      ) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      }
    },
    dropProxySockets: () => {
      proxySockets.destroyAll();
      tlsProxySockets.destroyAll();
    },
    close: async () => {
      for (const server of [origin, tlsOrigin, proxy, tlsProxyServer]) {
        (server as http.Server).closeAllConnections?.();
        server.close();
      }
      proxySockets.destroyAll();
      tlsProxySockets.destroyAll();
    },
  };
}

type ProxyAuthObservation = {
  outcome: 'response' | 'rejection' | 'hung';
  statusCode?: number;
  body?: string;
  error?: ErrorShape;
  originSaw?: ObservedRequest[];
  connectAuthorities?: string[];
  proxyAuthorizations?: (string | undefined)[];
  liveProxySockets?: number;
};

/** Runs one in-process request through the subject and reports what happened instead of throwing. */
export async function observeProxyRequest(
  subject: TransportSubject,
  params: {
    url: URL;
    signal: AbortSignal;
    environment: NodeJS.ProcessEnv;
    lab: ProxyAuthLab;
    caseDeadlineMs: number;
  },
): Promise<ProxyAuthObservation> {
  const mark = params.lab.mark();
  const deadline = params.caseDeadlineMs;
  const work = (async () => {
    const response = await subject.requestApprovedUrl({
      url: params.url,
      approvedAddress: APPROVED_ADDRESS,
      family: 4,
      headers: {},
      signal: params.signal,
      environment: params.environment,
    });
    let body = '';
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      body += Buffer.from(chunk).toString('utf8');
    }
    await response.close();
    return { response, body };
  })();
  const result = await Promise.race([
    work.then(
      (value) => ({ kind: 'ok' as const, value }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    ),
    new Promise<{ kind: 'hung' }>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'hung' }), deadline);
      timer.unref?.();
    }),
  ]);
  await params.lab.settleSince(mark);
  const base = {
    originSaw: params.lab.requestsSince(mark),
    connectAuthorities: params.lab.connectAuthoritiesSince(mark),
    proxyAuthorizations: params.lab.proxyAuthorizationsSince(mark),
    liveProxySockets: params.lab.liveProxySocketsSince(mark),
  };
  if (result.kind === 'hung') {
    params.lab.dropProxySockets();
    await params.lab.settleSince(mark);
    return { outcome: 'hung', ...base };
  }
  if (result.kind === 'failed') {
    return { outcome: 'rejection', ...base, error: errorShape(result.error) };
  }
  return {
    outcome: 'response',
    ...base,
    statusCode: result.value.response.statusCode,
    body: result.value.body,
  };
}

export type ProxyAuthScenario =
  | 'auth-http-proxy-http-origin'
  | 'auth-http-proxy-tls-origin'
  | 'auth-https-proxy-http-origin'
  | 'auth-named-https-proxy-tls-origin';

type ProxyAuthScenarioResult = {
  scenario: ProxyAuthScenario;
  outcome: 'response' | 'rejection';
  statusCode?: number;
  body?: string;
  sniHeader?: string;
  error?: ErrorShape;
  /**
   * Child TCP resources remaining above the initial process count. Use one scenario per child
   * to attribute the count to an individual request.
   */
  openSockets: number;
};

/**
 * Runs proxy-scheme scenarios in a fresh process. Any scenario that crosses TLS — the TLS origin
 * or the `https` proxy — needs the loopback fixture certificate trusted, and TLS trust is fixed
 * while a process starts, so the caller passes `NODE_EXTRA_CA_CERTS` at spawn time. The child owns
 * no listeners; the parent's lab records the CONNECT authorities and proxy credentials.
 */
export async function runProxyAuthScenarios(params: {
  /** Absolute path of the transport module the child imports. */
  subjectPath: string;
  originPort: number;
  tlsOriginPort: number;
  proxyPort: number;
  tlsProxyPort: number;
  scenarios: ProxyAuthScenario[];
  /** Trusts the loopback fixture certificate when true. */
  trustFixtureCertificate: boolean;
  fixtureCertificatePath: string;
}): Promise<ProxyAuthScenarioResult[]> {
  return await runTransportChild<ProxyAuthScenarioResult>(
    proxyChildSource(),
    [
      params.subjectPath,
      String(params.originPort),
      String(params.tlsOriginPort),
      String(params.proxyPort),
      String(params.tlsProxyPort),
      ...params.scenarios,
    ],
    params.trustFixtureCertificate ? params.fixtureCertificatePath : '',
    params.scenarios.length * 6_000,
  );
}

/**
 * The child's source. Plain ESM so the child needs no loader beyond type stripping: it imports the
 * transport module by absolute path. Arguments: transport module, the four lab ports, then the
 * scenarios to run.
 */
function proxyChildSource(): string {
  return `
import { pathToFileURL } from 'node:url';

const [subjectPath, originPort, tlsOriginPort, proxyPort, tlsProxyPort, ...scenarios] =
  process.argv.slice(2);
const { requestApprovedUrl } = await import(pathToFileURL(subjectPath).href);
const APPROVED_ADDRESS = '127.0.0.1';
const USER = ${JSON.stringify(PROXY_FIXTURE_USER)};
const PASSWORD = ${JSON.stringify(PROXY_FIXTURE_PASSWORD)};
const authProxy = (scheme, port) =>
  scheme + '://' + USER + ':' + PASSWORD + '@' + APPROVED_ADDRESS + ':' + port;

const shape = (error) => ({
  name: error?.name,
  code: error?.code,
  message: error?.message,
});

const scenarioSpec = {
  'auth-http-proxy-http-origin': {
    url: 'http://${APPROVED_HOSTNAME}:' + originPort + '/app.zip',
    environment: { http_proxy: authProxy('http', proxyPort), https_proxy: authProxy('http', proxyPort) },
  },
  'auth-http-proxy-tls-origin': {
    url: 'https://localhost:' + tlsOriginPort + '/artifact.bin',
    environment: { https_proxy: authProxy('http', proxyPort) },
  },
  'auth-https-proxy-http-origin': {
    url: 'http://${APPROVED_HOSTNAME}:' + originPort + '/app.zip',
    environment: { http_proxy: authProxy('https', tlsProxyPort), https_proxy: authProxy('https', tlsProxyPort) },
  },
  // The proxy URL names its host instead of spelling the loopback address, so the proxy handshake
  // carries that name as SNI, and the origin is TLS, so it echoes the origin SNI back.
  'auth-named-https-proxy-tls-origin': {
    url: 'https://localhost:' + tlsOriginPort + '/artifact.bin',
    environment: { https_proxy: 'https://' + USER + ':' + PASSWORD + '@localhost:' + tlsProxyPort },
  },
};

// Keeps the event loop alive until every scenario settles: a transport whose socket already died
// can otherwise leave the loop empty while the unref'd abort timer is still pending, and the
// process would exit before the signal fires.
const keepAlive = setInterval(() => {}, 250);

// The child owns no listeners, so a TCP socket handle it still holds is one the transport did not
// release. Counted before the first request so the report is the transport's own, not the child's.
const openSockets = () =>
  process.getActiveResourcesInfo().filter((kind) => kind === 'TCPSocketWrap').length;
const baselineSockets = openSockets();

for (const scenario of scenarios) {
  const spec = scenarioSpec[scenario];
  try {
    const response = await requestApprovedUrl({
      url: new URL(spec.url),
      approvedAddress: APPROVED_ADDRESS,
      family: 4,
      headers: {},
      signal: AbortSignal.timeout(4000),
      environment: spec.environment,
    });
    let body = '';
    for await (const chunk of response.body) body += Buffer.from(chunk).toString('utf8');
    const sni = response.headers['x-sni'];
    await response.close();
    console.log(JSON.stringify({
      scenario,
      outcome: 'response',
      statusCode: response.statusCode,
      body,
      sniHeader: Array.isArray(sni) ? sni[0] : sni,
      openSockets: openSockets() - baselineSockets,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      scenario,
      outcome: 'rejection',
      error: shape(error),
      openSockets: openSockets() - baselineSockets,
    }));
  }
}
clearInterval(keepAlive);
process.exit(0);
`;
}
