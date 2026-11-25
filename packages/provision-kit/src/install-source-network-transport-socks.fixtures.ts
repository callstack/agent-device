import net from 'node:net';
import type { AddressInfo } from 'node:net';

import {
  runTransportChild,
  transportModulePath,
} from './install-source-network-transport-tls.fixtures.ts';
import {
  APPROVED_ADDRESS,
  startLoopbackLabBase,
  trackSockets,
  type ErrorShape,
  type LabMark,
  type LoopbackLabBase,
  type ProxyFixture,
} from './install-source-network-transport.fixtures.ts';

/**
 * Loopback-only SOCKS5 lab for the install-source transport's SOCKS proxy route (#4674 evidence).
 *
 * The proxies speak RFC 1928, with the RFC 1929 username/password method, over raw sockets bound to
 * 127.0.0.1, and record the destination each tunnel request names — which is how a case proves the
 * transport asked for the approved address rather than the URL host. The origin, TLS origin, proxy
 * socket tracking and settling come from the shared loopback lab base.
 */

/** Synthetic fixture-only SOCKS credential. Not a real credential; only this lab accepts it. */
const SOCKS_FIXTURE_USER = 'fixture-only-user';
/** Synthetic fixture-only SOCKS credential. Not a real credential; only this lab accepts it. */
const SOCKS_FIXTURE_PASSWORD = 'fixture-only-secret';

/** What one SOCKS tunnel request named, and how the client authenticated. */
export type SocksTunnelRequest = {
  destination: string;
  authMethod: 'none' | 'username-password';
};

/**
 * How one SOCKS proxy answers a client: `none` accepts a no-auth handshake, `required` demands the
 * fixture username/password method, `silent` takes the greeting and never replies, and `refused`
 * rejects the tunnel request.
 */
type SocksProxyMode = 'none' | 'required' | 'silent' | 'refused';

/** The shared lab markers, plus the SOCKS greetings only this suite counts. */
export type SocksLabMark = LabMark & { greetings: number };

export type SocksLab = Omit<LoopbackLabBase, 'mark'> & {
  /** SOCKS proxy that grants a no-auth handshake. */
  socksPort: number;
  /** SOCKS proxy that accepts the TCP connection and never answers the handshake. */
  silentSocksPort: number;
  /** SOCKS proxy that rejects every tunnel request after the handshake. */
  refusedSocksPort: number;
  /** SOCKS proxy that demands the fixture username/password method. */
  authSocksPort: number;
  /** The proxy URL handed to the transport through the proxy environment variables. */
  socksProxyUrl(scheme: 'socks5' | 'socks', port: number, authenticated?: boolean): string;
  mark(): SocksLabMark;
  /** SOCKS greetings any of this lab's proxies received after `mark`. */
  greetingsSince(mark: SocksLabMark): number;
  /** How each tunnel request granted after `mark` authenticated itself. */
  tunnelAuthMethodsSince(mark: SocksLabMark): SocksTunnelRequest['authMethod'][];
};

const SOCKS_VERSION = 0x05;
const SOCKS_AUTH_NONE = 0x00;
const SOCKS_AUTH_USERNAME_PASSWORD = 0x02;
const SOCKS_AUTH_NO_ACCEPTABLE_METHODS = 0xff;
const SOCKS_REPLY_OK = 0x00;
const SOCKS_REPLY_CONNECTION_NOT_ALLOWED = 0x02;
const SOCKS_ADDRESS_IPV4 = 0x01;
const SOCKS_ADDRESS_DOMAIN = 0x03;
const SOCKS_ADDRESS_IPV6 = 0x04;
/** The reply a SOCKS5 username/password subnegotiation sends: revision 1 plus a status byte. */
const SOCKS_SUBNEGOTIATION_REVISION = 0x01;
const SOCKS_SUBNEGOTIATION_OK = 0x00;
const SOCKS_SUBNEGOTIATION_FAILED = 0x01;

export async function startSocksLab(root: string): Promise<SocksLab> {
  const requests: SocksTunnelRequest[] = [];
  let greetings = 0;
  const createProxy = (mode: SocksProxyMode): ProxyFixture =>
    createSocksProxyFixture({
      mode,
      requests,
      onGreeting: () => {
        greetings += 1;
      },
    });

  const socks = createProxy('none');
  const silentSocks = createProxy('silent');
  const refusedSocks = createProxy('refused');
  const authSocks = createProxy('required');
  const proxies = [socks, silentSocks, refusedSocks, authSocks];

  const base = await startLoopbackLabBase({
    root,
    proxies: () => proxies,
    connectAuthorities: () => requests.map((request) => request.destination),
  });

  return {
    ...base,
    socksPort: portOf(socks),
    silentSocksPort: portOf(silentSocks),
    refusedSocksPort: portOf(refusedSocks),
    authSocksPort: portOf(authSocks),
    socksProxyUrl: (scheme, port, authenticated = false) =>
      `${scheme}://${
        authenticated ? `${SOCKS_FIXTURE_USER}:${SOCKS_FIXTURE_PASSWORD}@` : ''
      }${APPROVED_ADDRESS}:${port}`,
    mark: () => ({ ...base.mark(), greetings }),
    greetingsSince: (mark) => greetings - mark.greetings,
    tunnelAuthMethodsSince: (mark) =>
      requests.slice(mark.connect).map((request) => request.authMethod),
  };
}

function portOf(proxy: ProxyFixture): number {
  return (proxy.server.address() as AddressInfo).port;
}

export type SocksTlsScenario = 'socks5-tls-origin' | 'socks-tls-origin';

export type SocksTlsScenarioResult = {
  scenario: SocksTlsScenario;
  outcome: 'response' | 'rejection';
  statusCode?: number;
  body?: string;
  /** The name the TLS origin saw at the handshake, echoed back by it. `'false'` means no SNI. */
  sniHeader?: string;
  /**
   * The protocol the TLS origin negotiated, echoed back by it. `'false'` means the handshake
   * negotiated none, which is what an origin reports for a client that offers none.
   */
  alpnHeader?: string;
  error?: ErrorShape;
  /**
   * Child TCP resources remaining above the initial process count, so a case can prove the SOCKS
   * dial released the sockets it opened.
   */
  openSockets: number;
};

/**
 * Runs the SOCKS-scheme scenarios that reach the TLS origin in a fresh process: the origin's
 * loopback fixture certificate can only be trusted at spawn time through `NODE_EXTRA_CA_CERTS`. The
 * child owns no listeners, so the parent's lab stays the single place that records tunnel
 * destinations, and the origin's echoed handshake facts are how the dial is verified.
 */
export async function runSocksTlsScenarios(params: {
  /** Absolute path of the transport module the child imports. */
  here: string;
  tlsOriginPort: number;
  socksPort: number;
  scenarios: SocksTlsScenario[];
  fixtureCertificatePath: string;
}): Promise<SocksTlsScenarioResult[]> {
  return await runTransportChild<SocksTlsScenarioResult>(
    socksTlsChildSource(),
    [
      transportModulePath(params.here),
      String(params.tlsOriginPort),
      String(params.socksPort),
      ...params.scenarios,
    ],
    params.fixtureCertificatePath,
    Math.max(1, params.scenarios.length) * 6_000,
  );
}

/**
 * The child's source. Plain ESM so the child needs no loader beyond type stripping: it imports the
 * transport module by absolute path. Arguments: transport module, the TLS origin port, the SOCKS
 * proxy port, then the scenarios to run, whose name supplies the proxy scheme.
 */
function socksTlsChildSource(): string {
  return `
import { pathToFileURL } from 'node:url';

const [subjectPath, tlsOriginPort, socksPort, ...scenarios] = process.argv.slice(2);
const { requestApprovedUrl } = await import(pathToFileURL(subjectPath).href);
const APPROVED_ADDRESS = '127.0.0.1';
const shape = (error) => ({
  name: error?.name,
  code: error?.code,
  message: error?.message,
});

// Keeps the event loop alive until every scenario settles, so a socket the transport still holds is
// counted rather than hidden by an early exit.
const keepAlive = setInterval(() => {}, 250);

// The child owns no listeners, so a TCP socket handle it still holds is one the transport did not
// release. Counted before the first request so the report is the transport's own, not the child's.
const openSockets = () =>
  process.getActiveResourcesInfo().filter((kind) => kind === 'TCPSocketWrap').length;
const baselineSockets = openSockets();

for (const scenario of scenarios) {
  const scheme = scenario.split('-')[0];
  try {
    const response = await requestApprovedUrl({
      url: new URL('https://localhost:' + tlsOriginPort + '/artifact.bin'),
      approvedAddress: APPROVED_ADDRESS,
      family: 4,
      headers: {},
      signal: AbortSignal.timeout(4000),
      environment: {
        http_proxy: scheme + '://' + APPROVED_ADDRESS + ':' + socksPort,
        https_proxy: scheme + '://' + APPROVED_ADDRESS + ':' + socksPort,
      },
    });
    let body = '';
    for await (const chunk of response.body) body += Buffer.from(chunk).toString('utf8');
    const sni = response.headers['x-sni'];
    const alpn = response.headers['x-alpn'];
    await response.close();
    console.log(JSON.stringify({
      scenario,
      outcome: 'response',
      statusCode: response.statusCode,
      body,
      sniHeader: Array.isArray(sni) ? sni[0] : sni,
      alpnHeader: Array.isArray(alpn) ? alpn[0] : alpn,
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

/** One SOCKS5 proxy listener: it records its tunnel requests and can be tracked and closed. */
function createSocksProxyFixture(params: {
  mode: SocksProxyMode;
  requests: SocksTunnelRequest[];
  onGreeting: () => void;
}): ProxyFixture {
  const server = net.createServer((client) => {
    client.on('error', () => {});
    let pending = Buffer.alloc(0);
    let phase: 'greeting' | 'auth' | 'request' | 'relay' = 'greeting';
    let authMethod: SocksTunnelRequest['authMethod'] = 'none';
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const consumed =
          phase === 'greeting'
            ? readGreeting()
            : phase === 'auth'
              ? readSubnegotiation()
              : phase === 'request'
                ? readRequest()
                : undefined;
        if (consumed === undefined) return;
        pending = pending.subarray(consumed);
      }
    };
    client.on('data', onData);

    /** The bytes consumed, or `undefined` while the fixture still waits for more. */
    function readGreeting(): number | undefined {
      if (pending.length < 2) return undefined;
      const methodCount = pending[1] ?? 0;
      if (pending.length < 2 + methodCount) return undefined;
      params.onGreeting();
      const methods = Array.from(pending.subarray(2, 2 + methodCount));
      const length = 2 + methodCount;
      if (params.mode === 'silent') {
        // Keeps the greeting without an answer, so a case can abort mid-handshake.
        phase = 'relay';
        return undefined;
      }
      if (params.mode === 'required' && !methods.includes(SOCKS_AUTH_USERNAME_PASSWORD)) {
        client.end(Buffer.from([SOCKS_VERSION, SOCKS_AUTH_NO_ACCEPTABLE_METHODS]));
        phase = 'relay';
        return length;
      }
      const chosen = params.mode === 'required' ? SOCKS_AUTH_USERNAME_PASSWORD : SOCKS_AUTH_NONE;
      client.write(Buffer.from([SOCKS_VERSION, chosen]));
      if (chosen === SOCKS_AUTH_USERNAME_PASSWORD) {
        phase = 'auth';
      } else {
        phase = 'request';
      }
      return length;
    }

    function readSubnegotiation(): number | undefined {
      if (pending.length < 3) return undefined;
      const userLength = pending[1] ?? 0;
      if (pending.length < 3 + userLength) return undefined;
      const passwordLength = pending[2 + userLength] ?? 0;
      const total = 3 + userLength + passwordLength;
      if (pending.length < total) return undefined;
      const user = pending.subarray(2, 2 + userLength).toString('utf8');
      const password = pending.subarray(3 + userLength, total).toString('utf8');
      if (user !== SOCKS_FIXTURE_USER || password !== SOCKS_FIXTURE_PASSWORD) {
        client.end(Buffer.from([SOCKS_SUBNEGOTIATION_REVISION, SOCKS_SUBNEGOTIATION_FAILED]));
        phase = 'relay';
        return total;
      }
      authMethod = 'username-password';
      client.write(Buffer.from([SOCKS_SUBNEGOTIATION_REVISION, SOCKS_SUBNEGOTIATION_OK]));
      phase = 'request';
      return total;
    }

    function readRequest(): number | undefined {
      if (pending.length < 5) return undefined;
      const address = readSocksRequestAddress(pending);
      if (address === undefined) return undefined;
      if (params.mode === 'refused') {
        client.end(socksReply(SOCKS_REPLY_CONNECTION_NOT_ALLOWED));
        phase = 'relay';
        return address.offset;
      }
      params.requests.push({
        destination: `${address.host}:${address.port}`,
        authMethod,
      });
      startRelay(address.host, address.port, address.offset);
      return address.offset;
    }

    function startRelay(host: string, port: number, consumed: number): void {
      phase = 'relay';
      client.removeListener('data', onData);
      const upstream = net.connect({ host, port });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      const rest = pending.subarray(consumed);
      upstream.once('connect', () => {
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        client.write(socksReply(SOCKS_REPLY_OK));
        upstream.pipe(client);
      });
    }
  });
  return { server, sockets: trackSockets(server) };
}

function socksReply(status: number): Buffer {
  return Buffer.from([SOCKS_VERSION, status, 0x00, SOCKS_ADDRESS_IPV4, 0, 0, 0, 0, 0, 0]);
}

/** The SOCKS5 request's target address and the offset just past its port. */
function readSocksRequestAddress(
  buffer: Buffer,
): { host: string; port: number; offset: number } | undefined {
  const offset = 4;
  const addressType = buffer[3];
  if (addressType === SOCKS_ADDRESS_IPV4) {
    if (buffer.length < offset + 6) return undefined;
    return {
      host: buffer.subarray(offset, offset + 4).join('.'),
      port: buffer.readUInt16BE(offset + 4),
      offset: offset + 6,
    };
  }
  if (addressType === SOCKS_ADDRESS_DOMAIN) {
    const length = buffer[offset] ?? 0;
    if (buffer.length < offset + 1 + length + 2) return undefined;
    return {
      host: buffer.subarray(offset + 1, offset + 1 + length).toString('utf8'),
      port: buffer.readUInt16BE(offset + 1 + length),
      offset: offset + 1 + length + 2,
    };
  }
  if (addressType === SOCKS_ADDRESS_IPV6) {
    if (buffer.length < offset + 18) return undefined;
    const groups: string[] = [];
    for (let index = 0; index < 16; index += 2) {
      groups.push(buffer.readUInt16BE(offset + index).toString(16));
    }
    return { host: groups.join(':'), port: buffer.readUInt16BE(offset + 16), offset: offset + 18 };
  }
  return undefined;
}
