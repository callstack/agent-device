import { expect, test } from 'vitest';
import { nodeHttpRequestUrl, normalizeDaemonPublicOrigin } from './daemon-http.ts';

test.each([
  ['HTTPS://Example.COM:443/', 'https://example.com'],
  ['http://[::1]:80', 'http://[::1]'],
  ['https://[::1]:8443', 'https://[::1]:8443'],
])('normalizes public origin %s', (input, expected) => {
  expect(normalizeDaemonPublicOrigin(input)).toBe(expected);
});

test.each([
  'https://example.com/a',
  'https://example.com?',
  'https://example.com#',
  'https://user@example.com',
  'https://example.com:0x10',
  'https://example.com:',
  String.raw`http://example.com\n`,
  'ftp://example.com',
])('rejects invalid origin %s', (input) => {
  expect(() => normalizeDaemonPublicOrigin(input)).toThrow();
});

test.each([0, 9, 10, 13, 31, 32, 92, 127])('rejects request target character %s', (code) => {
  expect(
    nodeHttpRequestUrl(`/path${String.fromCharCode(code)}name`, ['Host', 'example.com'], false),
  ).toBeNull();
});

test('retains encoded path characters and a valid query', () => {
  expect(nodeHttpRequestUrl('/path%20name?q=a%20b', ['Host', 'example.com'], true)?.href).toBe(
    'https://example.com/path%20name?q=a%20b',
  );
});
