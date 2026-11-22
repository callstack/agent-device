import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'vitest';

import { skipWhenLoopbackUnavailable } from '@agent-device/test-kit';

import * as nodeTransport from './install-source-network-transport.ts';
import { resolveProxyForUrl } from './install-source-network-transport.ts';
import { transportModulePath } from './install-source-network-transport-tls.fixtures.ts';
import {
  APPROVED_HOSTNAME,
  ARTIFACT_BODY,
  TRANSPORT_TEST_TIMEOUT_MS,
} from './install-source-network-transport.fixtures.ts';
import {
  EXPECTED_PROXY_AUTHORIZATION,
  authHttpProxyEnvironment,
  authProxyUrl,
  observeProxyRequest,
  runProxyAuthScenarios,
  startProxyAuthLab,
  type ProxyAuthLab,
  type ProxyAuthScenario,
} from './install-source-network-transport-proxy.fixtures.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

/** Loopback certificate trusted by the child process; its subject names cover `localhost`. */
const FIXTURE_CERTIFICATE = path.join(
  REPO_ROOT,
  'test/integration/provider-scenarios/fixtures/localhost-cert.pem',
);

let lab: ProxyAuthLab;

beforeAll(async () => {
  if (await skipWhenLoopbackUnavailable({ skip: () => {} }, 'install-source proxy-auth lab')) {
    return;
  }
  lab = await startProxyAuthLab(REPO_ROOT);
});

afterAll(async () => {
  await lab?.close();
});

test('current routing passes an auth-bearing proxy URL through unchanged for both URL schemes', () => {
  // Parity pin for the existing routing, not a NO_PROXY duplicate: the selected proxy URL keeps
  // its scheme and userinfo verbatim, which is used to create a
  // `Proxy-Authorization` header on CONNECT.
  const httpProxy = authProxyUrl('http', 8080);
  const tlsProxy = authProxyUrl('https', 8443);
  assert.equal(
    resolveProxyForUrl(new URL('http://example.net/app.zip'), {
      http_proxy: httpProxy,
      https_proxy: tlsProxy,
    }),
    httpProxy,
  );
  assert.equal(
    resolveProxyForUrl(new URL('https://example.net/app.zip'), {
      http_proxy: httpProxy,
      https_proxy: tlsProxy,
    }),
    tlsProxy,
  );
});

test(`an http-scheme proxy demanding fixture-only Basic auth completes the approved origin fetch`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const mark = lab.mark();
  const observed = await observeProxyRequest(nodeTransport, {
    url: new URL(`http://${APPROVED_HOSTNAME}:${lab.originPort}/app.zip`),
    signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
    environment: authHttpProxyEnvironment(lab.proxyPort),
    lab,
    caseDeadlineMs: TRANSPORT_TEST_TIMEOUT_MS + 500,
  });

  assert.equal(observed.outcome, 'response');
  assert.equal(observed.statusCode, 200);
  assert.equal(observed.body, ARTIFACT_BODY);
  assert.deepEqual(observed.connectAuthorities, ['127.0.0.1:<port>']);
  assert.deepEqual(observed.proxyAuthorizations, [EXPECTED_PROXY_AUTHORIZATION]);
  assert.deepEqual(observed.originSaw, [
    { method: 'GET', url: '/app.zip', host: 'approved.invalid:<port>' },
  ]);
  assert.equal(observed.liveProxySockets, 0);
  await lab.settleSince(mark);
});

test('an authenticated http-scheme proxy tunnels TLS to the approved origin under configured trust', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const scenarios: ProxyAuthScenario[] = ['auth-http-proxy-tls-origin'];
  const mark = lab.mark();
  const results = await runProxyAuthScenarios({
    subjectPath: transportModulePath(HERE),
    originPort: lab.originPort,
    tlsOriginPort: lab.tlsOriginPort,
    proxyPort: lab.proxyPort,
    tlsProxyPort: lab.tlsProxyPort,
    scenarios,
    trustFixtureCertificate: true,
    fixtureCertificatePath: FIXTURE_CERTIFICATE,
  });
  assert.deepEqual(
    results,
    [
      {
        scenario: 'auth-http-proxy-tls-origin',
        outcome: 'response',
        statusCode: 200,
        body: 'body',
        sniHeader: 'localhost',
        alpnHeader: 'http/1.1',
        openSockets: 0,
      },
    ],
    `the CONNECT must carry the fixture credential, the tunnel must keep the URL host as SNI and negotiate HTTP/1.1 at the origin, and close must leave no socket of its own`,
  );
  assert.deepEqual(lab.connectAuthoritiesSince(mark), ['127.0.0.1:<port>']);
  assert.deepEqual(lab.proxyAuthorizationsSince(mark), [EXPECTED_PROXY_AUTHORIZATION]);
  await lab.settleSince(mark);
});

test(
  'TLS proxy scheme (https proxy URL): the downloader completes the authenticated fetch through the TLS proxy',
  { timeout: 30_000 },
  async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;

    // Positive parity for the `https://` proxy scheme, run in a child so the loopback
    // fixture certificate can be trusted: the proxy dial must be a TLS handshake under normal
    // Node peer verification, then CONNECT carries the fixture credential
    // to the approved address and the fetch returns the artifact bytes.
    const mark = lab.mark();
    const results = await runProxyAuthScenarios({
      subjectPath: transportModulePath(HERE),
      originPort: lab.originPort,
      tlsOriginPort: lab.tlsOriginPort,
      proxyPort: lab.proxyPort,
      tlsProxyPort: lab.tlsProxyPort,
      scenarios: ['auth-https-proxy-http-origin'],
      trustFixtureCertificate: true,
      fixtureCertificatePath: FIXTURE_CERTIFICATE,
    });
    assert.deepEqual(
      results,
      [
        {
          scenario: 'auth-https-proxy-http-origin',
          outcome: 'response',
          statusCode: 200,
          body: ARTIFACT_BODY,
          openSockets: 0,
        },
      ],
      `an https-scheme proxy with fixture Basic auth must complete the approved fetch and release the sockets it dialed`,
    );
    assert.deepEqual(lab.connectAuthoritiesSince(mark), ['127.0.0.1:<port>']);
    assert.deepEqual(lab.proxyAuthorizationsSince(mark), [EXPECTED_PROXY_AUTHORIZATION]);
    await lab.settleSince(mark);
    assert.deepEqual(lab.proxySniSince(mark), [undefined]);
    assert.deepEqual(
      lab.proxyAlpnSince(mark),
      ['http/1.1'],
      `the proxy handshake must negotiate HTTP/1.1 offered by the transport`,
    );
    assert.equal(lab.liveProxySocketsSince(mark), 0);
  },
);

test(
  'named TLS proxy (https proxy URL): the downloader finishes the TLS handshake, then CONNECT and the TLS origin fetch',
  { timeout: 30_000 },
  async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;

    // Same `https://` proxy scheme with the proxy host written as a name rather than the loopback
    // address, over a TLS origin. The proxy handshake must present that name as SNI, the CONNECT
    // must then run inside the established TLS session and carry the fixture credential to the
    // approved address, and the origin handshake must keep the URL host as SNI and return the
    // artifact bytes.
    const scenarios: ProxyAuthScenario[] = ['auth-named-https-proxy-tls-origin'];
    const mark = lab.mark();
    const results = await runProxyAuthScenarios({
      subjectPath: transportModulePath(HERE),
      originPort: lab.originPort,
      tlsOriginPort: lab.tlsOriginPort,
      proxyPort: lab.proxyPort,
      tlsProxyPort: lab.tlsProxyPort,
      scenarios,
      trustFixtureCertificate: true,
      fixtureCertificatePath: FIXTURE_CERTIFICATE,
    });
    assert.deepEqual(
      results,
      [
        {
          scenario: 'auth-named-https-proxy-tls-origin',
          outcome: 'response',
          statusCode: 200,
          body: 'body',
          sniHeader: 'localhost',
          alpnHeader: 'http/1.1',
          openSockets: 0,
        },
      ],
      `a named https-scheme proxy must complete the authenticated TLS origin fetch with the URL host as origin SNI, must negotiate HTTP/1.1 at the origin, and must release the sockets it dialed`,
    );
    assert.deepEqual(
      lab.proxySniSince(mark),
      ['localhost'],
      `the proxy handshake must present the proxy host name as SNI`,
    );
    assert.deepEqual(
      lab.proxyAlpnSince(mark),
      ['http/1.1'],
      `the proxy handshake must negotiate HTTP/1.1 offered by the transport`,
    );
    assert.deepEqual(lab.connectAuthoritiesSince(mark), ['127.0.0.1:<port>']);
    assert.deepEqual(lab.proxyAuthorizationsSince(mark), [EXPECTED_PROXY_AUTHORIZATION]);
    await lab.settleSince(mark);
  },
);
