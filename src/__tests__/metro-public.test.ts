import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildAndroidRuntimeHints,
  buildBundleUrl,
  buildIosRuntimeHints,
  normalizeBaseUrl,
  resolveRuntimeTransport,
} from '../metro.ts';

test('public metro entrypoint exposes url and runtime hint helpers', () => {
  assert.equal(normalizeBaseUrl('https://bridge.example.test///'), 'https://bridge.example.test');
  assert.equal(
    buildBundleUrl('https://bridge.example.test/', 'ios'),
    'https://bridge.example.test/index.bundle?platform=ios&dev=true&minify=false',
  );
  assert.equal(
    buildIosRuntimeHints('https://public.example.test').bundleUrl,
    'https://public.example.test/index.bundle?platform=ios&dev=true&minify=false',
  );
  assert.equal(
    buildAndroidRuntimeHints('https://public.example.test').bundleUrl,
    'https://public.example.test/index.bundle?platform=android&dev=true&minify=false',
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
