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
    unnamedRequestIds: [],
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

test('a URL logged mid-sentence drops the separator that follows it', () => {
  const line =
    '2026-09-09 18:22:27.805 Df spicygolf[33656:4505afd] [com.apple.network:connection] [C9 Hostname#c6f77afc:3040 tcp, url: http://localhost:3040/v4/messages/en_US, definite, attribution: developer] start';
  const dump = readRecentNetworkTrafficFromText(`${line}\n`, {
    path: 'app.log',
    exists: true,
    backend: 'ios-simulator',
  });

  assert.equal(dump.entries[0]?.url, 'http://localhost:3040/v4/messages/en_US');
});

// Captured from a real iOS simulator app log: `/v4/messages/en_US` opens
// connection 9 and logs its URL, then `/init` reuses connection 9 ~350ms later
// and CFNetwork logs no URL for it anywhere.
const CONNECTION_START =
  '2026-09-09 18:22:27.805 Df spicygolf[33656:4505afd] [com.apple.network:connection] [C9 EA66F890-BE05-450D-BF6E-ADE5ADAC1CB8 Hostname#c6f77afc:3040 tcp, url: http://localhost:3040/v4/messages/en_US, definite, attribution: developer] start';
const OPENING_SUMMARY =
  '2026-09-09 18:22:27.816 Df spicygolf[33656:4505aed] [com.apple.CFNetwork:Summary] Task <10B2F1BA-8C9E-4877-80D2-994F1C3ED74A>.<1> summary for task success {transaction_duration_ms=11, response_status=200, connection=9, protocol="http/1.1", request_bytes=221, response_bytes=1214, cache_hit=true}';
const REUSED_SUMMARY =
  '2026-09-09 18:22:28.167 Df spicygolf[33656:4505ae4] [com.apple.CFNetwork:Summary] Task <2FAEF670-BB27-42A4-ACDD-6B6DF7D11510>.<2> summary for task success {transaction_duration_ms=1, response_status=200, connection=9, reused=1, reused_after_ms=0, request_bytes=236, response_bytes=624, cache_hit=true}';

function iosDump(lines: readonly string[]) {
  return readRecentNetworkTrafficFromText(`${lines.join('\n')}\n`, {
    path: 'app.log',
    exists: true,
    backend: 'ios-simulator',
  });
}

test('a request that reused a keep-alive connection is reported against its origin', () => {
  const dump = iosDump([CONNECTION_START, OPENING_SUMMARY, REUSED_SUMMARY]);
  const reused = dump.entries.find((entry) => entry.pathUnavailable);

  assert.equal(reused?.url, 'http://localhost:3040');
  assert.equal(reused?.status, 200);
  assert.equal(reused?.durationMs, 1);
  assert.equal(reused?.timestamp, '2026-09-09 18:22:28.167');
});

test('a task that opened its own connection is read from its URL-bearing line only', () => {
  const dump = iosDump([CONNECTION_START, OPENING_SUMMARY]);

  assert.deepEqual(
    dump.entries.map((entry) => entry.url),
    ['http://localhost:3040/v4/messages/en_US'],
  );
  assert.equal(dump.entries[0]?.pathUnavailable, undefined);
});

test('a reused request whose connection is outside the scanned window is not invented', () => {
  const dump = iosDump([REUSED_SUMMARY]);

  assert.deepEqual(dump.entries, []);
});

test('a recycled connection number resolves to the origin most recently opened for it', () => {
  const laterStart = CONNECTION_START.replace(
    'url: http://localhost:3040/v4/messages/en_US',
    'url: https://api.example.test/v1/session',
  );
  const dump = iosDump([CONNECTION_START, laterStart, REUSED_SUMMARY]);

  assert.equal(
    dump.entries.find((entry) => entry.pathUnavailable)?.url,
    'https://api.example.test',
  );
});

test('a reused request that never got a status drops the CFNetwork sentinel', () => {
  const failure = REUSED_SUMMARY.replace(
    'summary for task success',
    'summary for task failure',
  ).replace('response_status=200', 'response_status=-1');
  const dump = iosDump([CONNECTION_START, failure]);
  const reused = dump.entries.find((entry) => entry.pathUnavailable);

  assert.equal(reused?.url, 'http://localhost:3040');
  assert.equal(reused?.status, undefined);
});

test('android dumps do not pay for CFNetwork correlation', () => {
  const lines = `${[CONNECTION_START, REUSED_SUMMARY].join('\n')}\n`;
  assert.equal(iosDump([CONNECTION_START, REUSED_SUMMARY]).entries.length, 2);

  const dump = readRecentNetworkTrafficFromText(lines, {
    path: 'app.log',
    exists: true,
    backend: 'android',
  });

  assert.deepEqual(
    dump.entries.map((entry) => entry.url),
    ['http://localhost:3040/v4/messages/en_US'],
  );
  assert.equal(dump.unnamedRequestIds?.length, 0);
});

test('a reused request whose connection opened before the window is counted, not dropped', () => {
  const dump = iosDump([REUSED_SUMMARY]);

  assert.deepEqual(dump.entries, []);
  assert.equal(dump.unnamedRequestIds?.length, 1);
});

test('a resolved reused request is named, not counted as unnamed', () => {
  const dump = iosDump([CONNECTION_START, OPENING_SUMMARY, REUSED_SUMMARY]);

  assert.equal(dump.unnamedRequestIds?.length, 0);
  assert.equal(dump.entries.filter((entry) => entry.pathUnavailable).length, 1);
});

function withProcess(line: string, process: string): string {
  const swapped = line.replace(/spicygolf\[\d+:[0-9a-f]+\]/, process);
  if (swapped === line) throw new Error('fixture process token not found');
  return swapped;
}

test('a recycled connection number does not inherit the origin of a previous process', () => {
  const relaunchedSummary = REUSED_SUMMARY.replace(
    'spicygolf[33656:4505ae4]',
    'spicygolf[40001:4505ae4]',
  );
  const dump = iosDump([CONNECTION_START, relaunchedSummary]);

  assert.deepEqual(
    dump.entries.filter((entry) => entry.pathUnavailable),
    [],
  );
  assert.equal(dump.unnamedRequestIds?.length, 1);
});

test('a connection number is resolved within the process that opened it', () => {
  const otherProcessStart = withProcess(CONNECTION_START, 'otherapp[40001:4505afd]').replace(
    'url: http://localhost:3040/v4/messages/en_US',
    'url: https://wrong.example.test/x',
  );
  const dump = iosDump([otherProcessStart, CONNECTION_START, REUSED_SUMMARY]);

  assert.equal(dump.entries.find((entry) => entry.pathUnavailable)?.url, 'http://localhost:3040');
});

test('a line with no readable process identity leaves its traffic unnamed', () => {
  const dump = iosDump([
    CONNECTION_START.replace('spicygolf[33656:4505afd]', 'spicygolf'),
    REUSED_SUMMARY.replace('spicygolf[33656:4505ae4]', 'spicygolf'),
  ]);

  assert.deepEqual(
    dump.entries.filter((entry) => entry.pathUnavailable),
    [],
  );
  assert.equal(dump.unnamedRequestIds?.length, 1);
});

test('a URL whose path ends in punctuation is not truncated into a different endpoint', () => {
  const dump = iosDump([
    '2026-09-09 18:22:27.805 Df app[1:2] [com.example:Default] GET https://example.test/release. status=200',
  ]);

  assert.equal(dump.entries[0]?.url, 'https://example.test/release.');
});

test('a delimited url: field drops the separator the format put after it', () => {
  const dump = iosDump([CONNECTION_START]);

  assert.equal(dump.entries[0]?.url, 'http://localhost:3040/v4/messages/en_US');
});

// A second reused request on the same connection, distinct from REUSED_SUMMARY.
const SECOND_REUSED_SUMMARY = REUSED_SUMMARY.replace(
  'Task <2FAEF670-BB27-42A4-ACDD-6B6DF7D11510>.<2>',
  'Task <9C1D77B4-0E52-4A18-9D31-7F0A2B4C6E88>.<3>',
);

test('two windows over disjoint unnamed traffic report both requests, not the larger count', () => {
  const appLog = iosDump([REUSED_SUMMARY]);
  const recovery = iosDump([SECOND_REUSED_SUMMARY]);

  const merged = mergeNetworkDumps(recovery, appLog, 200);

  assert.equal(merged.unnamedRequestIds?.length, 2);
});

test('two windows over the same unnamed request report it once', () => {
  const appLog = iosDump([REUSED_SUMMARY, SECOND_REUSED_SUMMARY]);
  const recovery = iosDump([SECOND_REUSED_SUMMARY]);

  const merged = mergeNetworkDumps(recovery, appLog, 200);

  assert.equal(merged.unnamedRequestIds?.length, 2);
});

test('a request one window named is not still counted as unnamed from the other', () => {
  const appLog = iosDump([REUSED_SUMMARY]);
  const recovery = iosDump([CONNECTION_START, REUSED_SUMMARY]);

  assert.equal(appLog.unnamedRequestIds?.length, 1);
  assert.equal(recovery.unnamedRequestIds?.length, 0);

  const merged = mergeNetworkDumps(recovery, appLog, 200);

  assert.deepEqual(merged.unnamedRequestIds, []);
  assert.equal(merged.entries.filter((entry) => entry.pathUnavailable).length, 1);
});
