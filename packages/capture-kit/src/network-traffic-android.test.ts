import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readRecentNetworkTrafficFromText } from './network-traffic.ts';

test('preserves Android adjacent packet enrichment', () => {
  const dump = readRecentNetworkTrafficFromText(
    [
      '03-31 17:43:32.564 V/GIBSDK  (17434): [NetworkAgent]: packet id 23911610 added, queue size: 1',
      '03-31 17:43:32.700 V/OtherTag (17434): unrelated line 1',
      '03-31 17:43:32.800 V/OtherTag (17434): unrelated line 2',
      '03-31 17:43:32.900 V/OtherTag (17434): unrelated line 3',
      '03-31 17:43:33.000 V/OtherTag (17434): unrelated line 4',
      '03-31 17:43:33.031 D/GIBSDK  (17434): [NetworkAgent] packet id 23911610 total elapsed request/response time, ms: 377; response code: 200;',
      '03-31 17:43:33.032 D/GIBSDK  (17434): URL: https://api.example.com/fixture',
    ].join('\n'),
    {
      path: '/sessions/one/app.log',
      exists: true,
      backend: 'android',
      maxEntries: 5,
      include: 'summary',
      maxPayloadChars: 2048,
      maxScanLines: 100,
    },
  );

  assert.deepEqual(dump.entries[0], {
    method: undefined,
    url: 'https://api.example.com/fixture',
    status: 200,
    timestamp: '03-31 17:43:33.032',
    packetId: '23911610',
    durationMs: 377,
    raw: '03-31 17:43:33.032 D/GIBSDK  (17434): URL: https://api.example.com/fixture',
    line: 7,
  });
});
