import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mergeNetworkDumps, readRecentNetworkTrafficFromText } from './network-traffic.ts';

test('parses the existing include projections and newest-first order', () => {
  const dump = readRecentNetworkTrafficFromText(
    [
      '2026-02-24T10:00:00Z GET https://api.example.com/profile status=200',
      '2026-02-24T10:00:02Z {"method":"POST","url":"https://api.example.com/login","statusCode":401,"headers":{"x-id":"abc"},"requestBody":{"email":"u@example.com"},"responseBody":{"error":"denied"}}',
      'non-network-line',
    ].join('\n'),
    {
      path: '/sessions/one/app.log',
      exists: true,
      backend: 'ios-simulator',
      maxEntries: 5,
      include: 'all',
      maxPayloadChars: 2048,
      maxScanLines: 100,
    },
  );

  assert.equal(dump.exists, true);
  assert.equal(dump.entries.length, 2);
  assert.deepEqual(
    dump.entries.map(({ method, status }) => ({ method, status })),
    [
      { method: 'POST', status: 401 },
      { method: 'GET', status: 200 },
    ],
  );
  assert.equal(typeof dump.entries[0]?.headers, 'string');
  assert.equal(typeof dump.entries[0]?.requestBody, 'string');
  assert.equal(typeof dump.entries[0]?.responseBody, 'string');
});

test('keeps missing canonical app-log text distinct and merges recovery first', () => {
  const missing = readRecentNetworkTrafficFromText('', {
    path: '/sessions/one/app.log',
    exists: false,
    backend: 'android',
    maxEntries: 2,
    include: 'summary',
    maxPayloadChars: 2048,
    maxScanLines: 100,
  });
  const stale = readRecentNetworkTrafficFromText('GET https://stale.example.test status=200', {
    ...missing.limits,
    path: missing.path,
    exists: true,
    backend: 'android',
    include: 'summary',
  });
  const recovered = readRecentNetworkTrafficFromText('GET https://fresh.example.test status=201', {
    ...missing.limits,
    path: `${missing.path} (recovery)`,
    exists: true,
    backend: 'android',
    include: 'summary',
  });

  assert.deepEqual(missing, {
    path: '/sessions/one/app.log',
    exists: false,
    scannedLines: 0,
    matchedLines: 0,
    entries: [],
    include: 'summary',
    limits: { maxEntries: 2, maxPayloadChars: 2048, maxScanLines: 100 },
  });
  assert.deepEqual(
    mergeNetworkDumps(recovered, stale, 2).entries.map(({ url }) => url),
    ['https://fresh.example.test', 'https://stale.example.test'],
  );
});

test('keeps Android adjacent enrichment disabled for Apple backends', () => {
  const dump = readRecentNetworkTrafficFromText(
    [
      '2026-03-31 17:43:33.031 response code: 200',
      '2026-03-31 17:43:33.032 URL: https://api.example.com/fixture',
    ].join('\n'),
    {
      path: '/sessions/one/app.log',
      exists: true,
      backend: 'macos',
      maxEntries: 5,
      include: 'summary',
      maxPayloadChars: 2048,
      maxScanLines: 100,
    },
  );

  assert.equal(dump.entries[0]?.status, undefined);
  assert.equal(dump.entries[0]?.durationMs, undefined);
});

test('ignores documentation URLs without an explicit network signal', () => {
  const dump = readRecentNetworkTrafficFromText(
    '2026-04-02 08:14:44Z config warning. See https://docs.example.test/setup for help.\n',
    {
      path: '/sessions/one/app.log',
      exists: true,
      backend: 'ios-simulator',
      maxEntries: 5,
      include: 'summary',
      maxPayloadChars: 2048,
      maxScanLines: 100,
    },
  );

  assert.deepEqual(dump.entries, []);
});

test('applies a validated absolute line offset to host-selected text', () => {
  const options = {
    path: '/sessions/one/app.log',
    exists: true,
    backend: 'android' as const,
    maxEntries: 5,
    include: 'summary' as const,
    maxPayloadChars: 2048,
    maxScanLines: 100,
  };

  const dump = readRecentNetworkTrafficFromText('GET https://example.test status=200', {
    ...options,
    lineNumberOffset: 5000,
  });
  assert.equal(dump.entries[0]?.line, 5001);
  assert.throws(
    () =>
      readRecentNetworkTrafficFromText('GET https://example.test status=200', {
        ...options,
        lineNumberOffset: -1,
      }),
    /non-negative integer/,
  );
});
