import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  cacheFields,
  finalizeResult,
  isMethodRemovedInEra,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSIONS,
  negotiateLegacyProtocolVersion,
  PREFERRED_LEGACY_PROTOCOL_VERSION,
  resolveProtocolEra,
  UnsupportedProtocolVersionError,
} from '../protocol-era.ts';

const modernMeta = (version: string = MODERN_PROTOCOL_VERSION) => ({
  _meta: {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientCapabilities': {},
  },
});

test('initialize echoes a revision the client asked for instead of overriding it', () => {
  // A client pinned to 2025-06-18 that is answered with a different revision is told to
  // disconnect by the legacy lifecycle contract.
  assert.equal(negotiateLegacyProtocolVersion({ protocolVersion: '2025-06-18' }), '2025-06-18');
  assert.equal(
    negotiateLegacyProtocolVersion({ protocolVersion: PREFERRED_LEGACY_PROTOCOL_VERSION }),
    PREFERRED_LEGACY_PROTOCOL_VERSION,
  );
});

test('initialize falls back to the newest legacy revision for versions we do not implement', () => {
  assert.equal(
    negotiateLegacyProtocolVersion({ protocolVersion: '2024-11-05' }),
    PREFERRED_LEGACY_PROTOCOL_VERSION,
  );
  assert.equal(negotiateLegacyProtocolVersion({}), PREFERRED_LEGACY_PROTOCOL_VERSION);
  assert.equal(negotiateLegacyProtocolVersion(undefined), PREFERRED_LEGACY_PROTOCOL_VERSION);
});

test('initialize never agrees to a modern revision, which has no handshake to establish', () => {
  for (const version of MODERN_PROTOCOL_VERSIONS) {
    assert.equal(
      negotiateLegacyProtocolVersion({ protocolVersion: version }),
      PREFERRED_LEGACY_PROTOCOL_VERSION,
    );
  }
});

test('the declared revision picks the era, so 2025 stays on the legacy wire contract', () => {
  assert.equal(resolveProtocolEra('tools/list', modernMeta()), 'modern');
  for (const version of LEGACY_PROTOCOL_VERSIONS) {
    assert.equal(resolveProtocolEra('tools/list', modernMeta(version)), 'legacy');
  }
  assert.equal(resolveProtocolEra('tools/list', {}), 'legacy');
  assert.equal(resolveProtocolEra('tools/list', undefined), 'legacy');
});

test('server/discover requires modern request metadata rather than being promoted', () => {
  assert.equal(resolveProtocolEra('server/discover', modernMeta()), 'modern');
  // No declared revision: malformed, not an invitation to guess the era.
  assert.throws(() => resolveProtocolEra('server/discover', undefined), /protocolVersion/);
  assert.throws(() => resolveProtocolEra('server/discover', { _meta: {} }), /protocolVersion/);
  // The RPC does not exist in any legacy revision.
  assert.throws(
    () => resolveProtocolEra('server/discover', modernMeta(PREFERRED_LEGACY_PROTOCOL_VERSION)),
    UnsupportedProtocolVersionError,
  );
});

test('a declared revision without client capabilities is malformed', () => {
  assert.throws(
    () =>
      resolveProtocolEra('tools/call', {
        _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION },
      }),
    /clientCapabilities/,
  );
  assert.throws(
    () =>
      resolveProtocolEra('tools/call', {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': 'not-an-object',
        },
      }),
    /clientCapabilities/,
  );
});

test('an unimplemented declared revision is rejected with the supported list', () => {
  assert.throws(
    () => resolveProtocolEra('tools/call', modernMeta('1900-01-01')),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedProtocolVersionError);
      assert.equal(error.data.requested, '1900-01-01');
      assert.ok(error.data.supported.includes(MODERN_PROTOCOL_VERSION));
      return true;
    },
  );
});

test('a supplied clientInfo must be an Implementation, but omitting it is fine', () => {
  const withClientInfo = (clientInfo: unknown) => ({
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': clientInfo,
    },
  });

  const valid = { name: 'c', version: '1' };
  assert.equal(resolveProtocolEra('tools/list', modernMeta()), 'modern');
  assert.equal(resolveProtocolEra('tools/list', withClientInfo(valid)), 'modern');
  // Required means present and a string, not non-empty: the schema sets no minimum
  // length on `name`/`version`, nor on `Icon.src`.
  assert.equal(
    resolveProtocolEra('tools/list', withClientInfo({ name: '', version: '' })),
    'modern',
  );
  assert.equal(
    resolveProtocolEra('tools/list', withClientInfo({ ...valid, icons: [{ src: '' }] })),
    'modern',
  );
  // Every recognized optional field, plus an unknown extension key, stays acceptable.
  assert.equal(
    resolveProtocolEra(
      'tools/list',
      withClientInfo({
        ...valid,
        title: 'Client',
        description: 'A client',
        websiteUrl: 'https://example.dev',
        icons: [
          {
            src: 'https://example.dev/i.png',
            mimeType: 'image/png',
            sizes: ['48x48'],
            theme: 'light',
          },
        ],
        'com.example/extension': 1,
      }),
    ),
    'modern',
  );

  for (const bad of [
    42,
    'client',
    [],
    { name: 'c' },
    { version: '1' },
    { ...valid, title: 42 },
    { ...valid, description: 42 },
    { ...valid, websiteUrl: 42 },
    { ...valid, icons: 42 },
    { ...valid, icons: [{}] },
    { ...valid, icons: [{ src: 42 }] },
    { ...valid, icons: [{ src: 'https://e.dev/i.png', mimeType: 42 }] },
    { ...valid, icons: [{ src: 'https://e.dev/i.png', sizes: [48] }] },
    { ...valid, icons: [{ src: 'https://e.dev/i.png', sizes: 'any' }] },
    { ...valid, icons: [{ src: 'https://e.dev/i.png', theme: 'blue' }] },
  ]) {
    assert.throws(
      () => resolveProtocolEra('tools/list', withClientInfo(bad)),
      /clientInfo/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test('the modern era removes initialize and ping, the legacy era keeps them', () => {
  for (const method of ['initialize', 'ping']) {
    assert.equal(isMethodRemovedInEra(method, 'modern'), true);
    assert.equal(isMethodRemovedInEra(method, 'legacy'), false);
  }
  assert.equal(isMethodRemovedInEra('tools/call', 'modern'), false);
});

test('modern results carry resultType and serverInfo; legacy results are untouched', () => {
  const modern = finalizeResult({ tools: [] }, 'modern') as Record<string, unknown>;
  assert.equal(modern.resultType, 'complete');
  assert.deepEqual(Object.keys((modern._meta ?? {}) as object), [
    'io.modelcontextprotocol/serverInfo',
  ]);

  assert.deepEqual(finalizeResult({ tools: [] }, 'legacy'), { tools: [] });
});

test('finalizeResult preserves a result that already carries _meta', () => {
  const result = finalizeResult({ tools: [], _meta: { 'com.example/trace': 'abc' } }, 'modern') as {
    _meta: Record<string, unknown>;
  };
  assert.equal(result._meta['com.example/trace'], 'abc');
  assert.ok(result._meta['io.modelcontextprotocol/serverInfo']);
});

test('cache hints ride modern results only', () => {
  assert.deepEqual(cacheFields('modern', 1000), { ttlMs: 1000, cacheScope: 'public' });
  assert.equal(cacheFields('legacy', 1000), undefined);
});
