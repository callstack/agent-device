import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  cacheFields,
  finalizeResult,
  MODERN_PROTOCOL_VERSION,
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

test('a declared protocol version selects the modern era, its absence stays legacy', () => {
  assert.equal(resolveProtocolEra('tools/list', modernMeta()), 'modern');
  assert.equal(resolveProtocolEra('tools/list', {}), 'legacy');
  assert.equal(resolveProtocolEra('tools/list', undefined), 'legacy');
});

test('server/discover is modern even without _meta, so the probe reports the real era', () => {
  assert.equal(resolveProtocolEra('server/discover', undefined), 'modern');
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
