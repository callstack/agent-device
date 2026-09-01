import assert from 'node:assert/strict';
import { test } from 'vitest';
import { matchesNoProxy, resolveProxyForUrl } from './install-source-network-transport.ts';

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
