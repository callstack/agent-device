import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'vitest';

import { skipWhenLoopbackUnavailable } from '@agent-device/test-kit';

import * as nodeTransport from './install-source-network-transport.ts';
import {
  runTlsScenarios,
  transportModulePath,
  type TlsScenario,
} from './install-source-network-transport-tls.fixtures.ts';
import {
  ARTIFACT_BODY,
  APPROVED_HOSTNAME,
  TRANSPORT_TEST_TIMEOUT_MS,
  approvedUrl,
  directEnvironment,
  noProxyEnvironment,
  observeRequest,
  operatorAbortAfter,
  proxiedEnvironment,
  startLoopbackLab,
  type LoopbackLab,
} from './install-source-network-transport.fixtures.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

/** Loopback certificate trusted by the TLS child process; its subject names cover `localhost`. */
const FIXTURE_CERTIFICATE = path.join(
  REPO_ROOT,
  'test/integration/provider-scenarios/fixtures/localhost-cert.pem',
);

let lab: LoopbackLab;

beforeAll(async () => {
  // The lab binds 127.0.0.1, so it follows the shared loopback policy: an environment that only
  // optionally restricts loopback binds leaves the lab unstarted and each test skips itself, while
  // one that requires loopback coverage fails here. There is no test context in a hook, so the
  // skip arm is a no-op; the per-test guard reports the skip.
  if (
    await skipWhenLoopbackUnavailable({ skip: () => {} }, 'install-source transport loopback lab')
  ) {
    return;
  }
  lab = await startLoopbackLab(REPO_ROOT);
});

afterAll(async () => {
  await lab?.close();
});

function run(params: {
  url: URL;
  headers?: Record<string, string>;
  signal: AbortSignal;
  environment: NodeJS.ProcessEnv;
  readBody?: 'none';
  caseDeadlineMs?: number;
}) {
  return observeRequest(nodeTransport, { lab, ...params });
}

test(`a direct request keeps the URL identity and dials the approved address`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: new URL(`http://${APPROVED_HOSTNAME}:${lab.originPort}/app.zip?token=abc`),
    headers: { 'x-custom': 'yes' },
    signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
    environment: directEnvironment(),
  });

  assert.equal(observed.outcome, 'response');
  assert.equal(observed.statusCode, 200);
  assert.equal(observed.body, ARTIFACT_BODY);
  assert.deepEqual(observed.headers ?? {}, {
    'content-type': ['application/octet-stream'],
    'x-repeated': ['a', 'b'],
    'set-cookie': ['c=1', 'd=2'],
    'x-origin-host': [`approved.invalid:<port>`],
  });
  assert.deepEqual(observed.originSaw, [
    {
      method: 'GET',
      url: '/app.zip?token=abc',
      host: 'approved.invalid:<port>',
      custom: 'yes',
    },
  ]);
  assert.deepEqual(observed.connectAuthorities, []);
});

test(`a 302 is returned un-followed so the download contract owns redirects`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: approvedUrl(lab.originPort, '/redirect'),
    signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
    environment: directEnvironment(),
  });

  assert.equal(observed.statusCode, 302);
  assert.deepEqual(observed.headers?.['location'], ['http://cdn.invalid/final']);
  assert.equal(observed.originSaw?.length, 1);
});

test(`a proxied request tunnels to the approved address and keeps the Host name`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: new URL(`http://${APPROVED_HOSTNAME}:${lab.originPort}/app.zip`),
    headers: { 'x-custom': 'yes' },
    signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
    environment: proxiedEnvironment(lab.proxyPort),
  });

  assert.equal(observed.statusCode, 200);
  assert.equal(observed.body, ARTIFACT_BODY);
  assert.deepEqual(observed.connectAuthorities, ['127.0.0.1:<port>']);
  assert.deepEqual(observed.originSaw?.[0]?.host, 'approved.invalid:<port>');
  assert.equal(observed.liveProxySockets, 0);
});

test(`NO_PROXY scoped to the URL host bypasses the proxy`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: new URL(`http://${APPROVED_HOSTNAME}:${lab.originPort}/app.zip`),
    signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
    environment: noProxyEnvironment(lab.proxyPort, APPROVED_HOSTNAME),
  });

  assert.equal(observed.statusCode, 200);
  assert.deepEqual(observed.connectAuthorities, []);
});

test(`a proxy that refuses CONNECT fails the request with the tunnel status`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: approvedUrl(lab.refusalPort),
    signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
    environment: proxiedEnvironment(lab.proxyPort),
  });

  assert.equal(observed.outcome, 'rejection');
  // The error identifies the CONNECT refusal status.
  assert.match(observed.error?.message ?? '', /Proxy response \(502\) !== 200 when HTTP Tunneling/);
  assert.equal(observed.liveProxySockets, 0);
  assert.equal(observed.error?.code, 'EPROXYTUNNEL');
});

test(`a refused TCP connection is reported as ECONNREFUSED`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: new URL('http://approved.invalid:1/app.zip'),
    signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
    environment: directEnvironment(),
  });

  assert.equal(observed.outcome, 'rejection');
  assert.equal(observed.error?.code, 'ECONNREFUSED');
  assert.equal(observed.error?.message, 'connect ECONNREFUSED 127.0.0.1:1');
});

test(`an operator abort before the response rejects with the caller's own error`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: approvedUrl(lab.silentPort),
    signal: operatorAbortAfter(150),
    environment: directEnvironment(),
  });

  assert.equal(observed.outcome, 'rejection');
  assert.equal(observed.error?.message, 'operator stop');
});

test(`an operator abort before the response rejects through a proxy tunnel`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: approvedUrl(lab.silentPort),
    signal: operatorAbortAfter(150),
    environment: proxiedEnvironment(lab.proxyPort),
  });

  assert.equal(observed.outcome, 'rejection');
  assert.equal(observed.error?.message, 'operator stop');
  assert.equal(observed.liveProxySockets, 0);
});

test(`a signal timeout before the response rejects as a timeout`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: approvedUrl(lab.silentPort),
    signal: AbortSignal.timeout(150),
    environment: directEnvironment(),
  });

  assert.equal(observed.outcome, 'rejection');
  assert.equal(observed.error?.name, 'TimeoutError');
  assert.equal(observed.error?.message, 'The operation was aborted due to timeout');
});

test(`an operator abort mid-body delivers the bytes read and ends the stream with the caller's error`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: approvedUrl(lab.stallerPort),
    signal: operatorAbortAfter(200),
    environment: directEnvironment(),
  });

  assert.equal(observed.statusCode, 200);
  assert.equal(observed.outcome, 'stream-interrupted');
  assert.equal(observed.body, 'partial-chunk');
  assert.equal(observed.error?.message, 'operator stop');
});

test(`an operator abort mid-body through a proxy ends the stream with the caller's error`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: approvedUrl(lab.stallerPort),
    signal: operatorAbortAfter(200),
    environment: proxiedEnvironment(lab.proxyPort),
  });

  assert.equal(observed.statusCode, 200);
  assert.equal(observed.outcome, 'stream-interrupted');
  assert.equal(observed.body, 'partial-chunk');
  assert.equal(observed.error?.message, 'operator stop');
  assert.equal(observed.liveProxySockets, 0);
});

test(`close releases the body and the connection, and a second call is reported`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: new URL(`http://${APPROVED_HOSTNAME}:${lab.originPort}/app.zip`),
    signal: AbortSignal.timeout(TRANSPORT_TEST_TIMEOUT_MS),
    environment: proxiedEnvironment(lab.proxyPort),
    readBody: 'none',
  });

  assert.equal(observed.statusCode, 200);
  assert.deepEqual(observed.closeResults?.[0], 'ok');
  assert.equal(observed.liveProxySockets, 0);
  assert.deepEqual(observed.closeResults?.[1], 'ok');
});

test(`a proxy that never answers CONNECT is closed on caller cancellation`, async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed = await run({
    url: approvedUrl(lab.stalledConnectPort),
    signal: operatorAbortAfter(150),
    environment: proxiedEnvironment(lab.proxyPort),
  });

  assert.equal(observed.outcome, 'rejection');
  assert.equal(observed.error?.message, 'operator stop');
  assert.deepEqual(observed.connectAuthorities, ['127.0.0.1:<port>']);
  assert.equal(observed.liveProxySockets, 0);
});

test('The downloader derives TLS trust, SNI, ALPN, and the certificate identity check from the URL host', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // TLS trust is fixed when a process starts, so the test runs the TLS scenarios in a child
  // process spawned with the loopback fixture certificate as an extra CA. The child owns no
  // listeners: the parent's TLS origin echoes the SNI name and the negotiated protocol it saw, and
  // that is how the dial is verified.
  const scenarios: TlsScenario[] = [
    'direct',
    'proxied',
    'proxied-literal-ip',
    'direct-altname-mismatch',
    'direct-literal-ip',
  ];
  const results = await runTlsScenarios({
    subjectPath: transportModulePath(HERE),
    tlsOriginPort: lab.tlsOriginPort,
    proxyPort: lab.proxyPort,
    scenarios,
    trustFixtureCertificate: true,
    fixtureCertificatePath: FIXTURE_CERTIFICATE,
  });
  const byScenario = new Map(results.map((result) => [result.scenario, result]));

  // SNI names the URL host, so the server answers with that name. A literal IP cannot be an SNI
  // name, and the client omits it there; the fixture certificate covers `127.0.0.1` as an IP
  // subject alternative name, so those connections still complete. The origin advertises
  // `http/1.1`, so the echoed protocol proves the origin leg offered the protocol the transport
  // speaks; an origin reports `false` for a client that offers none.
  const expectedOriginHandshake: [TlsScenario, string][] = [
    ['direct', 'localhost'],
    ['proxied', 'localhost'],
    ['proxied-literal-ip', 'false'],
    ['direct-literal-ip', 'false'],
  ];
  for (const [scenario, sniHeader] of expectedOriginHandshake) {
    assert.deepEqual(
      { scenario, ...byScenario.get(scenario) },
      {
        scenario,
        outcome: 'response',
        statusCode: 200,
        body: 'body',
        sniHeader,
        alpnHeader: 'http/1.1',
      },
      'a trusted loopback certificate must complete the request with the URL host as SNI and must negotiate HTTP/1.1 at the origin',
    );
  }
  assert.equal(
    byScenario.get('direct-altname-mismatch')?.error?.code,
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'the certificate identity check must stay on the URL host',
  );
});

test('The downloader rejects the loopback fixture certificate when it is not trusted', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const [result] = await runTlsScenarios({
    subjectPath: transportModulePath(HERE),
    tlsOriginPort: lab.tlsOriginPort,
    proxyPort: lab.proxyPort,
    scenarios: ['direct'],
    trustFixtureCertificate: false,
    fixtureCertificatePath: FIXTURE_CERTIFICATE,
  });
  assert.equal(result?.outcome, 'rejection');
  assert.equal(result?.error?.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
});
