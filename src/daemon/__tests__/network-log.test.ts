import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRecentNetworkTraffic } from '../network-log.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

test('readRecentNetworkTraffic parses latest HTTP entries from session log', () => {
  const tempDir = mkdtempForTestSync('agent-device-network-log-');
  const logPath = path.join(tempDir, 'app.log');
  fs.writeFileSync(
    logPath,
    [
      '2026-02-24T10:00:00Z GET https://api.example.com/v1/profile status=200',
      '2026-02-24T10:00:02Z {"method":"POST","url":"https://api.example.com/v1/login","statusCode":401,"headers":{"x-id":"abc"},"requestBody":{"email":"u@example.com"},"responseBody":{"error":"denied"}}',
      'non-network-line',
    ].join('\n'),
    'utf8',
  );

  const dump = readRecentNetworkTraffic(logPath, {
    backend: 'ios-simulator',
    maxEntries: 5,
    include: 'all',
    maxPayloadChars: 2048,
    maxScanLines: 100,
  });

  assert.equal(dump.exists, true);
  assert.equal(dump.entries.length, 2);
  assert.equal(dump.entries[0]?.method, 'POST');
  assert.equal(dump.entries[0]?.url, 'https://api.example.com/v1/login');
  assert.equal(dump.entries[0]?.status, 401);
  assert.equal(dump.entries[0]?.timestamp, '2026-02-24T10:00:02Z');
  assert.equal(typeof dump.entries[0]?.headers, 'string');
  assert.equal(typeof dump.entries[0]?.requestBody, 'string');
  assert.equal(typeof dump.entries[0]?.responseBody, 'string');
  assert.equal(dump.entries[1]?.method, 'GET');
  assert.equal(dump.entries[1]?.status, 200);
  assert.equal(dump.entries[1]?.timestamp, '2026-02-24T10:00:00Z');
});

test('readRecentNetworkTraffic enriches Android GIBSDK URL lines with timing metadata', () => {
  const tempDir = mkdtempForTestSync('agent-device-network-log-');
  const logPath = path.join(tempDir, 'app.log');
  fs.writeFileSync(
    logPath,
    [
      '03-31 17:43:32.564 V/GIBSDK  (17434): [NetworkAgent]: packet id 23911610 added, queue size: 1',
      '03-31 17:43:33.031 D/GIBSDK  (17434): [NetworkAgent] packet id 23911610 total elapsed request/response time, ms: 377; response code: 200;',
      '03-31 17:43:33.031 D/GIBSDK  (17434): URL: https://api.example.com/v1/fixture?as=2.0.2816300925',
      '03-31 17:43:33.032 V/GIBSDK  (17434): [NetworkAgent]: packet id 23911610 sent successfully, 0 left in queue',
    ].join('\n'),
    'utf8',
  );

  const dump = readRecentNetworkTraffic(logPath, {
    backend: 'android',
    maxEntries: 5,
    include: 'summary',
    maxPayloadChars: 2048,
    maxScanLines: 100,
  });

  assert.equal(dump.exists, true);
  assert.equal(dump.entries.length, 1);
  assert.equal(dump.entries[0]?.url, 'https://api.example.com/v1/fixture?as=2.0.2816300925');
  assert.equal(dump.entries[0]?.timestamp, '03-31 17:43:33.031');
  assert.equal(dump.entries[0]?.status, 200);
  assert.equal(dump.entries[0]?.durationMs, 377);
  assert.equal(dump.entries[0]?.packetId, '23911610');
});

test('readRecentNetworkTraffic tolerates interleaved Android lines within the packet scan window', () => {
  const tempDir = mkdtempForTestSync('agent-device-network-log-');
  const logPath = path.join(tempDir, 'app.log');
  fs.writeFileSync(
    logPath,
    [
      '03-31 17:43:32.564 V/GIBSDK  (17434): [NetworkAgent]: packet id 23911610 added, queue size: 1',
      '03-31 17:43:32.700 V/OtherTag (17434): unrelated line 1',
      '03-31 17:43:32.800 V/OtherTag (17434): unrelated line 2',
      '03-31 17:43:32.900 V/OtherTag (17434): unrelated line 3',
      '03-31 17:43:33.000 V/OtherTag (17434): unrelated line 4',
      '03-31 17:43:33.031 D/GIBSDK  (17434): [NetworkAgent] packet id 23911610 total elapsed request/response time, ms: 377; response code: 200;',
      '03-31 17:43:33.032 D/GIBSDK  (17434): URL: https://api.example.com/v1/fixture?as=2.0.2816300925',
    ].join('\n'),
    'utf8',
  );

  const dump = readRecentNetworkTraffic(logPath, {
    backend: 'android',
    maxEntries: 5,
    include: 'summary',
    maxPayloadChars: 2048,
    maxScanLines: 100,
  });

  assert.equal(dump.entries.length, 1);
  assert.equal(dump.entries[0]?.status, 200);
  assert.equal(dump.entries[0]?.durationMs, 377);
  assert.equal(dump.entries[0]?.packetId, '23911610');
});

test('readRecentNetworkTraffic keeps Android packet enrichment disabled for Apple backends', () => {
  const tempDir = mkdtempForTestSync('agent-device-network-log-');
  const logPath = path.join(tempDir, 'app.log');
  fs.writeFileSync(
    logPath,
    [
      '2026-03-31 17:43:33.031 response code: 200',
      '2026-03-31 17:43:33.032 URL: https://api.example.com/v1/fixture?as=2.0.2816300925',
    ].join('\n'),
    'utf8',
  );

  const dump = readRecentNetworkTraffic(logPath, {
    backend: 'macos',
    maxEntries: 5,
    include: 'summary',
    maxPayloadChars: 2048,
    maxScanLines: 100,
  });

  assert.equal(dump.entries.length, 1);
  assert.equal(dump.entries[0]?.url, 'https://api.example.com/v1/fixture?as=2.0.2816300925');
  assert.equal(dump.entries[0]?.timestamp, '2026-03-31 17:43:33.032');
  assert.equal(dump.entries[0]?.status, undefined);
  assert.equal(dump.entries[0]?.durationMs, undefined);
});

test('readRecentNetworkTraffic ignores plain documentation URLs in non-network log messages', () => {
  const tempDir = mkdtempForTestSync('agent-device-network-log-');
  const logPath = path.join(tempDir, 'app.log');
  fs.writeFileSync(
    logPath,
    '2026-04-02 08:14:44.371 E Agent Device Tester[32193:8c7e18d] Airship config warning. See https://docs.airship.com/platform/mobile/setup/sdk/ios/#url-allow-list for more information.\n',
    'utf8',
  );

  const dump = readRecentNetworkTraffic(logPath, {
    backend: 'ios-simulator',
    maxEntries: 5,
    include: 'summary',
    maxPayloadChars: 2048,
    maxScanLines: 100,
  });

  assert.equal(dump.entries.length, 0);
});

test('readRecentNetworkTraffic returns empty result when log file is missing', () => {
  const logPath = path.join(os.tmpdir(), 'agent-device-network-log-missing', 'app.log');
  const dump = readRecentNetworkTraffic(logPath, {
    backend: 'android',
    maxEntries: 10,
    include: 'summary',
  });
  assert.equal(dump.exists, false);
  assert.equal(dump.entries.length, 0);
});
