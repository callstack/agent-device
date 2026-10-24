import { expect, test } from 'vitest';
import { readNetworkProbeTrafficFromText } from './network-probe-traffic.ts';

const options = {
  path: '/sessions/one/network.jsonl',
  exists: true,
  maxEntries: 25,
  include: 'summary' as const,
  maxPayloadChars: 2048,
  maxScanLines: 4000,
};

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

test('reads probe lines newest first with url, method, status, and duration', () => {
  const content = [
    line({
      method: 'GET',
      url: 'https://api.example.test/v1/a',
      status: 200,
      duration_ms: 12,
      timestamp_ms: 1_760_000_000_000,
    }),
    line({
      method: 'POST',
      url: 'https://api.example.test/v1/b',
      status: 201,
      duration_ms: 34.6,
      timestamp_ms: 1_760_000_001_000,
    }),
  ].join('\n');

  const { dump } = readNetworkProbeTrafficFromText(content, options);

  expect(dump.exists).toBe(true);
  expect(dump.scannedLines).toBe(2);
  expect(dump.matchedLines).toBe(2);
  expect(dump.entries[0]).toMatchObject({
    method: 'POST',
    url: 'https://api.example.test/v1/b',
    status: 201,
    durationMs: 35,
    timestamp: new Date(1_760_000_001_000).toISOString(),
    line: 2,
  });
  expect(dump.entries[1]).toMatchObject({
    method: 'GET',
    url: 'https://api.example.test/v1/a',
    status: 200,
    durationMs: 12,
  });
});

test('skips a line without a URL and a malformed line without failing the dump', () => {
  const content = [
    '{"method":"GET"}',
    'not json at all',
    '{"url":"https://ok.example.test","status":204}',
    '{"probe_error":"x"}',
  ].join('\n');

  const { dump } = readNetworkProbeTrafficFromText(content, options);

  expect(dump.entries).toHaveLength(1);
  expect(dump.entries[0]).toMatchObject({ url: 'https://ok.example.test', status: 204 });
  expect(dump.entries[0]!.line).toBe(3);
});

test('carries the request error when the probe saw no response', () => {
  const content = line({
    method: 'GET',
    url: 'https://gone.example.test',
    status: null,
    error: 'The internet connection appears to be offline.',
  });

  const { dump } = readNetworkProbeTrafficFromText(content, options);

  expect(dump.entries[0]).toMatchObject({
    url: 'https://gone.example.test',
    error: 'The internet connection appears to be offline.',
  });
  expect(dump.entries[0]).not.toHaveProperty('status');
});

test('formats headers only for an include mode that asks for them', () => {
  const content = line({
    url: 'https://h.example.test',
    status: 200,
    request_headers: { Accept: 'application/json' },
    response_headers: { 'Content-Type': 'application/json' },
  });

  const summary = readNetworkProbeTrafficFromText(content, options).dump;
  expect(summary.entries[0]).not.toHaveProperty('headers');

  const withHeaders = readNetworkProbeTrafficFromText(content, {
    ...options,
    include: 'headers',
  }).dump;
  expect(withHeaders.entries[0]?.headers).toContain('request:');
  expect(withHeaders.entries[0]?.headers).toContain('Accept: application/json');
  expect(withHeaders.entries[0]?.headers).toContain('response:');
});

test('honours the entry bound against newer lines and reports missing files as empty', () => {
  const content = Array.from({ length: 10 }, (_, i) =>
    line({ url: `https://api.example.test/v1/${i}`, status: 200 }),
  ).join('\n');

  const { dump } = readNetworkProbeTrafficFromText(content, { ...options, maxEntries: 3 });
  expect(dump.entries).toHaveLength(3);
  expect(dump.entries.map((entry) => entry.url)).toEqual([
    'https://api.example.test/v1/9',
    'https://api.example.test/v1/8',
    'https://api.example.test/v1/7',
  ]);

  const missing = readNetworkProbeTrafficFromText('', { ...options, exists: false }).dump;
  expect(missing.exists).toBe(false);
  expect(missing.entries).toEqual([]);
});

test('keeps absolute file line numbers after a skipped-line offset', () => {
  const content = line({ url: 'https://api.example.test/v1/late', status: 200 });

  const { dump } = readNetworkProbeTrafficFromText(content, {
    ...options,
    lineNumberOffset: 400,
  });

  expect(dump.entries[0]?.line).toBe(401);
});
