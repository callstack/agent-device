import { expect, test } from 'vitest';
import { normalizeDaemonPublicOrigin } from './daemon-http.ts';

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
  'http://example.com\\n',
  'ftp://example.com',
])('rejects invalid origin %s', (input) => {
  expect(() => normalizeDaemonPublicOrigin(input)).toThrow();
});
