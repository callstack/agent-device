import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildBundleUrl } from './bundle-url.ts';

test('buildBundleUrl normalizes the base URL and adds Metro query parameters', () => {
  assert.equal(
    buildBundleUrl('https://example.test///', 'ios'),
    'https://example.test/index.bundle?platform=ios&dev=true&minify=false',
  );
});

test('buildBundleUrl preserves the URL path and serializes a custom entry path', () => {
  assert.equal(
    buildBundleUrl(
      'https://example.test:8081/api/metro/runtimes/runtime-1/',
      'android',
      '.expo/.virtual-metro-entry.bundle',
    ),
    'https://example.test:8081/api/metro/runtimes/runtime-1/.expo/.virtual-metro-entry.bundle?platform=android&dev=true&minify=false',
  );
});
