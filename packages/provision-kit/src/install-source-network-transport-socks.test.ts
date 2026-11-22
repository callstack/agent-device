import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'vitest';

import { skipWhenLoopbackUnavailable } from '@agent-device/test-kit';

import * as nodeTransport from './install-source-network-transport.ts';
import {
  APPROVED_HOSTNAME,
  ARTIFACT_BODY,
  SETTLE_DEADLINE_MS,
  SETTLE_POLL_MS,
  TRANSPORT_TEST_TIMEOUT_MS,
  approvedUrl,
  observeRequest,
  operatorAbortAfter,
} from './install-source-network-transport.fixtures.ts';
import {
  runSocksTlsScenarios,
  startSocksLab,
  type SocksLab,
} from './install-source-network-transport-socks.fixtures.ts';

/**
 * Pins the SOCKS proxy route the Undici-backed transport served before #4674 replaced it: a
 * `socks5://` or `socks://` proxy must tunnel to the approved address and deliver the artifact
 * bytes. Each case hands the transport a URL whose host is a reserved bad name, so an origin that
 * served the request proves the tunnel was built and the request carried the URL identity.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

/** Loopback certificate trusted by the TLS child process; its subject names cover `localhost`. */
const FIXTURE_CERTIFICATE = path.join(
  REPO_ROOT,
  'test/integration/provider-scenarios/fixtures/localhost-cert.pem',
);

let lab: SocksLab;

beforeAll(async () => {
  // The lab binds 127.0.0.1, so it follows the shared loopback policy: an environment that only
  // optionally restricts loopback binds leaves the lab unstarted and each test skips itself, while
  // one that requires loopback coverage fails here. There is no test context in a hook, so the
  // skip arm is a no-op; the per-test guard reports the skip.
  if (await skipWhenLoopbackUnavailable({ skip: () => {} }, 'install-source SOCKS lab')) {
    return;
  }
  lab = await startSocksLab(REPO_ROOT);
});

afterAll(async () => {
  await lab?.close();
});

/** The same SOCKS proxy selected for both URL schemes, as an operator would set it. */
function socksEnvironment(proxyUrl: string): NodeJS.ProcessEnv {
  return { http_proxy: proxyUrl, https_proxy: proxyUrl };
}

function run(params: { url: URL; signal: AbortSignal; environment: NodeJS.ProcessEnv }) {
  return observeRequest(nodeTransport, { lab, ...params });
}

test.for(['socks5', 'socks'] as const)(
  'a %s proxy tunnels to the approved address and returns the artifact bytes',
  async (scheme, t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const observed = await run({
      url: new URL(`http://${APPROVED_HOSTNAME}:${lab.originPort}/app.zip`),
      signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
      environment: socksEnvironment(lab.socksProxyUrl(scheme, lab.socksPort)),
    });

    assert.equal(observed.outcome, 'response');
    assert.equal(observed.statusCode, 200);
    assert.equal(observed.body, ARTIFACT_BODY);
    assert.deepEqual(observed.connectAuthorities, ['127.0.0.1:<port>']);
    assert.deepEqual(observed.originSaw, [
      { method: 'GET', url: '/app.zip', host: 'approved.invalid:<port>' },
    ]);
    assert.equal(observed.liveProxySockets, 0);
  },
);

test('a socks proxy whose URL names credentials authenticates the handshake', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // This proxy grants the tunnel only to a client that completes the username/password
  // subnegotiation with the fixture credential, so a 200 with the observed method proves the
  // transport forwarded the proxy URL's userinfo instead of sending an unauthenticated greeting.
  const mark = lab.mark();
  const observed = await run({
    url: approvedUrl(lab.originPort),
    signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
    environment: socksEnvironment(lab.socksProxyUrl('socks5', lab.authSocksPort, true)),
  });

  assert.equal(observed.outcome, 'response');
  assert.equal(observed.statusCode, 200);
  assert.equal(observed.body, ARTIFACT_BODY);
  assert.deepEqual(observed.connectAuthorities, ['127.0.0.1:<port>']);
  assert.deepEqual(lab.tunnelAuthMethodsSince(mark), ['username-password']);
  assert.equal(observed.liveProxySockets, 0);
});

test('a socks proxy that refuses the tunnel request fails the request', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const mark = lab.mark();
  const observed = await run({
    url: approvedUrl(lab.originPort),
    signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
    environment: socksEnvironment(lab.socksProxyUrl('socks5', lab.refusedSocksPort)),
  });

  assert.equal(observed.outcome, 'rejection');
  assert.equal(lab.greetingsSince(mark), 1, 'the proxy must have received the SOCKS greeting');
  assert.deepEqual(
    lab.connectAuthoritiesSince(mark),
    [],
    'a refused tunnel request is not an established tunnel',
  );
  assert.deepEqual(observed.originSaw ?? [], []);
  assert.equal(observed.liveProxySockets, 0);
});

test('a refused socks proxy dial is reported as ECONNREFUSED', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // Nothing listens on the port the proxy URL names, so the dial to the proxy fails before any
  // handshake byte is sent: the transport must surface that as the socket error, not an error of
  // its own, and must not leave an unhandled socket error behind.
  const observed = await run({
    url: approvedUrl(lab.originPort),
    signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
    environment: socksEnvironment(lab.socksProxyUrl('socks5', 1)),
  });

  assert.equal(observed.outcome, 'rejection');
  assert.equal(observed.error?.code, 'ECONNREFUSED');
  assert.deepEqual(observed.connectAuthorities, []);
});

test('an operator abort while the socks proxy dial never connects rejects with the caller error', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // 10.255.255.1 is private space no host on this network answers, so the dial to it neither
  // connects nor errors and only the caller's signal can end the connect-phase wait. The dial is
  // the one await on this route the transport cannot end through a request or a body, so the await
  // itself must carry the signal, and the socket it abandons must be destroyed.
  const openDialResources = () =>
    process
      .getActiveResourcesInfo()
      // A dial that has not connected holds both the socket and its connect request.
      .filter((kind) => kind === 'TCPSocketWrap' || kind === 'ConnectWrap').length;
  const mark = lab.mark();
  const baselineDialResources = openDialResources();
  // Node releases a destroyed socket's handle just after it reports the socket closed, so this
  // settles on the same schedule as the lab's own socket census.
  const settleDialResources = async () => {
    const deadline = Date.now() + SETTLE_DEADLINE_MS;
    let open = openDialResources();
    while (Date.now() < deadline && open > baselineDialResources) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      open = openDialResources();
    }
    return open;
  };

  const observed = await run({
    url: approvedUrl(lab.originPort),
    signal: operatorAbortAfter(150),
    environment: socksEnvironment('socks5://10.255.255.1:1080'),
  });

  assert.equal(observed.outcome, 'rejection');
  assert.equal(observed.error?.message, 'operator stop');
  assert.equal(
    lab.greetingsSince(mark),
    0,
    'a dial that reached the proxy would have sent the SOCKS greeting',
  );
  assert.deepEqual(lab.connectAuthoritiesSince(mark), []);
  assert.deepEqual(observed.originSaw ?? [], []);
  assert.equal(observed.liveProxySockets, 0);
  assert.equal(
    (await settleDialResources()) - baselineDialResources,
    0,
    'the aborted dial must leave no socket open',
  );
});

test('an operator abort during the socks handshake rejects with the caller error', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // This proxy receives the greeting and answers nothing, so the abort lands mid-handshake.
  const mark = lab.mark();
  const observed = await run({
    url: approvedUrl(lab.originPort),
    signal: operatorAbortAfter(150),
    environment: socksEnvironment(lab.socksProxyUrl('socks5', lab.silentSocksPort)),
  });

  assert.equal(observed.outcome, 'rejection');
  assert.equal(observed.error?.message, 'operator stop');
  assert.equal(lab.greetingsSince(mark), 1, 'the proxy must have received the SOCKS greeting');
  assert.deepEqual(observed.connectAuthorities, []);
  assert.equal(observed.liveProxySockets, 0);
});

test(
  'a TLS origin reached through a socks5 or socks proxy keeps the URL host as SNI and negotiates HTTP/1.1',
  { timeout: 30_000 },
  async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    // The SOCKS tunnel carries the origin TLS session, so the shared TLS origin answers with the
    // handshake facts. TLS trust is fixed when a process starts, so this runs the scenarios in a
    // child spawned with the loopback fixture certificate as an extra CA.
    const mark = lab.mark();
    const results = await runSocksTlsScenarios({
      here: HERE,
      tlsOriginPort: lab.tlsOriginPort,
      socksPort: lab.socksPort,
      scenarios: ['socks5-tls-origin', 'socks-tls-origin'],
      fixtureCertificatePath: FIXTURE_CERTIFICATE,
    });

    assert.deepEqual(results, [
      {
        scenario: 'socks5-tls-origin',
        outcome: 'response',
        statusCode: 200,
        body: 'body',
        sniHeader: 'localhost',
        alpnHeader: 'http/1.1',
        openSockets: 0,
      },
      {
        scenario: 'socks-tls-origin',
        outcome: 'response',
        statusCode: 200,
        body: 'body',
        sniHeader: 'localhost',
        alpnHeader: 'http/1.1',
        openSockets: 0,
      },
    ]);
    assert.deepEqual(lab.connectAuthoritiesSince(mark), ['127.0.0.1:<port>', '127.0.0.1:<port>']);
    assert.deepEqual(lab.tunnelAuthMethodsSince(mark), ['none', 'none']);
  },
);
