import { expect, test } from 'vitest';
import { daemonBaseUrlIsLocal } from './daemon-resolution.ts';

test('a daemon base URL on loopback addresses this machine', () => {
  expect(daemonBaseUrlIsLocal(undefined)).toBe(true);
  expect(daemonBaseUrlIsLocal('')).toBe(true);
  expect(daemonBaseUrlIsLocal('http://localhost:4560')).toBe(true);
  expect(daemonBaseUrlIsLocal('http://127.0.0.1:4560/rpc')).toBe(true);
  expect(daemonBaseUrlIsLocal('http://[::1]:4560')).toBe(true);
});

test('a daemon base URL off loopback addresses another machine', () => {
  expect(daemonBaseUrlIsLocal('https://fleet.example.test')).toBe(false);
  expect(daemonBaseUrlIsLocal('http://10.0.0.7:4560')).toBe(false);
  // An unusable base URL is refused when the transport resolves it; here it is treated as remote.
  expect(daemonBaseUrlIsLocal('not a url')).toBe(false);
});
