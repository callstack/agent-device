import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildBundleUrl, normalizeBaseUrl, resolveRuntimeTransport } from '../sdk/metro.ts';

test('public metro entrypoint exposes url and transport helpers', () => {
  assert.equal(normalizeBaseUrl('https://bridge.example.test///'), 'https://bridge.example.test');
  assert.equal(
    buildBundleUrl('https://bridge.example.test/', 'ios'),
    'https://bridge.example.test/index.bundle?platform=ios&dev=true&minify=false',
  );
  assert.deepEqual(
    resolveRuntimeTransport({
      platform: 'ios',
      bundleUrl: 'https://10.0.0.10:8082/index.bundle?platform=ios',
    }),
    {
      host: '10.0.0.10',
      port: 8082,
      scheme: 'https',
    },
  );
});

test('public metro entrypoint does not expose runtime hint builders', async () => {
  const metro = (await import('../sdk/metro.ts')) as Record<string, unknown>;

  assert.equal(metro.buildIosRuntimeHints, undefined);
  assert.equal(metro.buildAndroidRuntimeHints, undefined);
});
