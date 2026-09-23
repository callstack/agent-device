import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { test, vi } from 'vitest';
import {
  matchesNoProxy,
  requestApprovedUrl,
  resolveProxyForUrl,
} from './install-source-network-transport.ts';

test('lowercase proxy variables override uppercase even when empty', () => {
  assert.equal(
    resolveProxyForUrl(new URL('http://example.net'), {
      http_proxy: '',
      HTTP_PROXY: 'http://uppercase-proxy',
    }),
    undefined,
  );
  assert.equal(
    resolveProxyForUrl(new URL('https://example.net'), {
      https_proxy: '',
      HTTPS_PROXY: 'http://uppercase-proxy',
      http_proxy: 'http://fallback-proxy',
    }),
    'http://fallback-proxy',
  );
});

test('HTTPS proxy selection falls back to the selected HTTP proxy', () => {
  assert.equal(
    resolveProxyForUrl(new URL('https://example.net'), { http_proxy: 'http://proxy' }),
    'http://proxy',
  );
});

test('NO_PROXY matches exact hosts, subdomains, ports, wildcards, and bracketed IPv6', () => {
  assert.equal(matchesNoProxy(new URL('https://example.com'), 'example.com'), true);
  assert.equal(matchesNoProxy(new URL('https://sub.example.com'), 'example.com'), true);
  assert.equal(matchesNoProxy(new URL('https://example.com:444'), 'example.com:443'), false);
  assert.equal(
    matchesNoProxy(new URL('https://[2001:4860:4860::8888]'), '[2001:4860:4860::8888]'),
    true,
  );
  assert.equal(matchesNoProxy(new URL('https://elsewhere.example'), '*'), true);
});

test('direct requests connect to the approved address through the real lookup', async () => {
  vi.stubEnv('no_proxy', '*');
  const server = http.createServer((_request, response) => response.end('artifact'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await requestApprovedUrl({
      url: new URL(`http://approved.invalid:${port}/app.zip`),
      approvedAddress: '127.0.0.1',
      family: 4,
      headers: {},
      signal: AbortSignal.timeout(5_000),
    });
    try {
      assert.equal(response.statusCode, 200);
      assert.equal(await text(response.body), 'artifact');
    } finally {
      await response.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  }
});
