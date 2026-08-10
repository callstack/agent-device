import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseEmbeddedNetworkJson,
  parseNetworkStatusCode,
  parseNetworkTimestamp,
  readNetworkBody,
  readNetworkHeaders,
  readNetworkJsonNumber,
  readNetworkJsonString,
} from './network-traffic-value.ts';

test('decodes embedded network fields without widening parsed JSON', () => {
  const line =
    'prefix {"method":"POST","statusCode":"201","headers":{"x-id":"abc"},"requestBody":{"ok":true}}';
  const decoded = parseEmbeddedNetworkJson(line);

  assert.equal(readNetworkJsonString(decoded, ['method']), 'POST');
  assert.equal(readNetworkJsonNumber(decoded, ['statusCode']), 201);
  assert.equal(readNetworkHeaders(line, decoded), '{"x-id":"abc"}');
  assert.equal(readNetworkBody(line, decoded, ['requestBody']), '{"ok":true}');
  assert.equal(parseNetworkStatusCode('response code: 204'), 204);
  assert.equal(parseNetworkTimestamp('2026-04-02T08:14:44Z GET'), '2026-04-02T08:14:44Z');
});

test('treats malformed embedded JSON as absent', () => {
  assert.equal(parseEmbeddedNetworkJson('prefix {bad json}'), null);
});
