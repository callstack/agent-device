import { test } from 'vitest';
import assert from 'node:assert/strict';
import { truncateUtf8 } from '../truncate-utf8.ts';

test('truncateUtf8 leaves short strings untouched', () => {
  assert.equal(truncateUtf8('Save', 256), 'Save');
  assert.equal(truncateUtf8('', 256), '');
});

test('truncateUtf8 truncates ASCII text at the byte budget and appends the marker', () => {
  const value = 'a'.repeat(300);
  const result = truncateUtf8(value, 256);
  assert.equal(Buffer.byteLength(result, 'utf8'), 256);
  assert.ok(result.endsWith('…'));
  assert.equal(result.slice(0, -1), 'a'.repeat(253));
});

test('truncateUtf8 never splits a multi-byte UTF-8 sequence', () => {
  // Each emoji is 4 UTF-8 bytes; a byte budget landing mid-codepoint must back
  // off to the previous whole codepoint boundary.
  const value = '😀'.repeat(80);
  const result = truncateUtf8(value, 100);
  assert.ok(Buffer.byteLength(result, 'utf8') <= 100);
  assert.ok(result.endsWith('…'));
  // Every remaining character before the marker must round-trip cleanly.
  const withoutMarker = result.slice(0, -1);
  assert.equal(Buffer.from(withoutMarker, 'utf8').toString('utf8'), withoutMarker);
  assert.equal(withoutMarker.length % 2, 0); // surrogate pairs stay paired
});

test('truncateUtf8 handles a budget smaller than the marker itself', () => {
  const result = truncateUtf8('a'.repeat(10), 1);
  assert.equal(result, '…');
});
