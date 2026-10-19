import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeBaseUrl } from './base-url.ts';

test('normalizeBaseUrl trims trailing slashes without changing other characters', () => {
  assert.equal(normalizeBaseUrl('https://example.test'), 'https://example.test');
  assert.equal(normalizeBaseUrl('https://example.test/'), 'https://example.test');
  assert.equal(normalizeBaseUrl('https://example.test///'), 'https://example.test');
  assert.equal(normalizeBaseUrl('/'), '');
  assert.equal(normalizeBaseUrl('////'), '');
  assert.equal(
    normalizeBaseUrl('https://example.test/path/?q=1'),
    'https://example.test/path/?q=1',
  );
});
