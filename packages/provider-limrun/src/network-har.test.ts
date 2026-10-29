import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { DestinationTunnelInspectionEvent } from '@limrun/api/destination-tunnel-inspection';
import { DestinationTunnelSessionError } from '@limrun/api/destination-tunnel-dialer';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import {
  DEFAULT_LIMRUN_HAR_SELECTORS,
  HAR_MAX_BYTES,
  startLimrunHarCapture,
} from './network-har.ts';

function harEntry(url: string, error?: string, comment?: string): DestinationTunnelInspectionEvent {
  return {
    type: 'complete',
    sequence: 1,
    requestId: `req-${url}`,
    data: {
      startedDateTime: new Date().toISOString(),
      time: 12,
      request: {
        method: 'GET',
        url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
      },
      ...(comment ? { comment } : {}),
      response: {
        // The tunnel reports a request it could not complete with status 0.
        status: error ? 0 : 200,
        statusText: error ? '' : 'OK',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [],
        content: { size: 0, mimeType: 'application/json' },
        redirectURL: '',
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: { send: 0, wait: 10, receive: 2 },
      _limrun: { tunnelId: 't1', selectorId: 's1', ...(error ? { error } : {}) },
    },
  } as unknown as DestinationTunnelInspectionEvent;
}

function fakeTunnelClient(
  lastDialFailure?: {
    tunnelId: string;
    selectorId: string;
    reason: string;
    osCode?: string;
  },
  tunnelClose: () => void = () => {},
) {
  const started: {
    selectors: string[];
    onEvent?: (e: DestinationTunnelInspectionEvent) => void;
    onError?: (error: Error) => void;
  }[] = [];
  return {
    started,
    client: {
      startTunnel: async (options: {
        selectors: string[];
        onInspectionEvent?: (event: DestinationTunnelInspectionEvent) => void;
        onInspectionError?: (error: Error) => void;
      }) => {
        started.push({
          selectors: options.selectors,
          onEvent: options.onInspectionEvent,
          onError: options.onInspectionError,
        });
        return {
          tunnelId: 't1',
          selectors: [{ id: 's1', kind: 'domain', value: '*.com' }],
          close: tunnelClose,
        } as never;
      },
      getTunnelStatus: async () => (lastDialFailure ? { lastDialFailure } : {}),
    },
  };
}

function tempHarPath(): string {
  return path.join(mkdtempForTestSync('limrun-har-'), 'session', 'har.har');
}

test('the default capture selectors carry the public wildcards and the Metro route', () => {
  assert.ok(DEFAULT_LIMRUN_HAR_SELECTORS.includes('*.com'));
  // One tunnel per instance: the Metro/companion route must ride this same tunnel.
  assert.ok(DEFAULT_LIMRUN_HAR_SELECTORS.includes('localhost:8081'));
});

function readEntries(harPath: string): { response: { status: number } }[] {
  return (
    JSON.parse(fs.readFileSync(harPath, 'utf8')) as {
      log: { entries: { response: { status: number } }[] };
    }
  ).log.entries;
}

function readEntryCount(harPath: string): number {
  return readEntries(harPath).length;
}

test('completed requests reach the live HAR in one coalesced, owner-only write', async () => {
  const fake = fakeTunnelClient();
  const harPath = tempHarPath();
  // An existing, wider directory is tightened too.
  fs.mkdirSync(path.dirname(harPath), { recursive: true, mode: 0o755 });
  const result = await startLimrunHarCapture(fake.client, { harPath });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const emit = fake.started[0]?.onEvent;
  assert.ok(emit);
  emit(harEntry('https://example.com/a'));
  emit(harEntry('https://example.com/b'));
  assert.equal(readEntryCount(harPath), 0);

  await vi.waitFor(() => assert.equal(readEntryCount(harPath), 2));
  const document = JSON.parse(fs.readFileSync(harPath, 'utf8')) as {
    log: { version: string; entries: unknown[] };
  };
  assert.equal(document.log.version, '1.2');
  assert.equal(document.log.entries.length, 2);
  assert.equal(fs.statSync(harPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(harPath)).mode & 0o777, 0o700);

  // Close flushes a request that is still inside the coalescing window.
  emit(harEntry('https://example.com/c'));
  await result.capture.close();
  assert.equal(readEntryCount(harPath), 3);
  assert.deepEqual(
    fs.readdirSync(path.dirname(harPath)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('the HAR keeps the newest entries under its size cap and reports the dropped ones', async () => {
  const fake = fakeTunnelClient();
  const harPath = tempHarPath();
  const result = await startLimrunHarCapture(fake.client, { harPath });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const emit = fake.started[0]?.onEvent;
  assert.ok(emit);
  // Two UTF-8 bytes per character: a quarter of the cap in bytes, an eighth in string length.
  const large = 'é'.repeat(Math.ceil(HAR_MAX_BYTES / 8));
  for (let index = 0; index < 6; index += 1) {
    emit(harEntry(`https://example.com/${index}`, undefined, large));
  }
  await result.capture.close();

  const urls = (
    JSON.parse(fs.readFileSync(harPath, 'utf8')) as {
      log: { entries: { request: { url: string } }[] };
    }
  ).log.entries.map((entry) => entry.request.url);
  assert.deepEqual(urls, [
    'https://example.com/3',
    'https://example.com/4',
    'https://example.com/5',
  ]);
  assert.ok(fs.statSync(harPath).size <= HAR_MAX_BYTES);
  const report = await result.capture.failures();
  assert.equal(report.byKind['har-truncated']?.count, 3);
});

test('a relative HAR path is refused before any directory is touched', async () => {
  const fake = fakeTunnelClient();
  const result = await startLimrunHarCapture(fake.client, { harPath: 'capture.har' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'tunnel-start-failed');
  assert.equal(fake.started.length, 0);
});

test('a capture whose HAR cannot be written refuses before the tunnel opens', async () => {
  const fake = fakeTunnelClient();
  const harPath = tempHarPath();
  // A non-empty directory where the HAR belongs: the rename into place fails.
  fs.mkdirSync(harPath, { recursive: true });
  fs.writeFileSync(path.join(harPath, 'occupied'), '');
  const result = await startLimrunHarCapture(fake.client, { harPath });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'tunnel-start-failed');
  assert.equal(fake.started.length, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(harPath)), [path.basename(harPath)]);
});

test('a tunnel that refuses to close still gets its HAR written, and a later close retries', async () => {
  let closeAttempts = 0;
  const fake = fakeTunnelClient(undefined, () => {
    closeAttempts += 1;
    if (closeAttempts === 1) throw new Error('socket busy');
  });
  const harPath = tempHarPath();
  const result = await startLimrunHarCapture(fake.client, { harPath });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  fake.started[0]?.onEvent?.(harEntry('https://example.com/a'));

  await assert.rejects(() => result.capture.close(), /socket busy/);
  assert.equal(readEntryCount(harPath), 1);
  await result.capture.close();
  await result.capture.close();
  assert.equal(closeAttempts, 2);
});

test('tunnel failures are counted, with the latest endpoints and the typed dial reason', async () => {
  const fake = fakeTunnelClient({
    tunnelId: 't1',
    selectorId: 's1',
    reason: 'dns_not_found',
    osCode: 'ENOTFOUND',
  });
  const result = await startLimrunHarCapture(fake.client, { harPath: tempHarPath() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const started = fake.started[0];
  assert.ok(started?.onEvent && started.onError);
  started.onEvent(harEntry('https://example.com/ok'));
  started.onEvent(
    harEntry('https://missing.example.com/a', 'tunnel client could not open the destination'),
  );
  started.onEvent({
    type: 'inspection_error',
    sequence: 3,
    data: { host: 'pinned.example.com', port: 443, message: 'terminate app TLS: EOF' },
  });
  started.onEvent({
    type: 'gap',
    sequence: 9,
    data: { fromSequence: 4, toSequence: 8, message: 'events dropped' },
  });
  started.onError(new Error('inspection stream closed'));

  const report = await result.capture.failures();
  assert.equal(report.total, 4);
  const endpoints = Object.fromEntries(
    Object.entries(report.byKind).map(([kind, entry]) => [
      kind,
      { count: entry.count, latest: entry.latest.map(({ host, port }) => ({ host, port })) },
    ]),
  );
  assert.deepEqual(endpoints, {
    'request-failed': { count: 1, latest: [{ host: 'missing.example.com', port: 443 }] },
    'inspection-error': { count: 1, latest: [{ host: 'pinned.example.com', port: 443 }] },
    'inspection-gap': { count: 1, latest: [{ host: undefined, port: undefined }] },
    'inspection-stream-error': { count: 1, latest: [{ host: undefined, port: undefined }] },
  });
  assert.deepEqual(report.lastDialFailure, {
    reason: 'dns_not_found',
    osCode: 'ENOTFOUND',
    selector: '*.com',
  });
  // The failed request stays in the HAR, as a status-0 entry.
  await result.capture.close();
  assert.deepEqual(
    readEntries(result.capture.harPath).map((entry) => entry.response.status),
    [200, 0],
  );
});

test('inspection errors from pinned hosts do not evict failed requests', async () => {
  const fake = fakeTunnelClient();
  const result = await startLimrunHarCapture(fake.client, { harPath: tempHarPath() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const emit = fake.started[0]?.onEvent;
  assert.ok(emit);
  emit(harEntry('https://api.example.com/login', 'client_dial_failed'));
  for (let sequence = 0; sequence < 20; sequence += 1) {
    emit({
      type: 'inspection_error',
      sequence,
      data: { host: 'pinned.example.com', port: 443, message: 'terminate app TLS: EOF' },
    });
  }
  const report = await result.capture.failures();
  assert.equal(report.total, 21);
  assert.equal(report.byKind['inspection-error']?.count, 20);
  assert.equal(report.byKind['inspection-error']?.latest.length, 5);
  assert.equal(report.byKind['request-failed']?.latest[0]?.host, 'api.example.com');
  await result.capture.close();
});

test("another tunnel's dial failure is not reported as this capture's", async () => {
  const fake = fakeTunnelClient({ tunnelId: 'older', selectorId: 's1', reason: 'client_timeout' });
  const result = await startLimrunHarCapture(fake.client, { harPath: tempHarPath() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const report = await result.capture.failures();
  assert.equal(report.total, 0);
  assert.equal(report.lastDialFailure, undefined);
  await result.capture.close();
});

test('a tunnel conflict is reported as a typed refusal, not a crash', async () => {
  const result = await startLimrunHarCapture(
    {
      startTunnel: async () => {
        throw new DestinationTunnelSessionError('already_active');
      },
    },
    { harPath: tempHarPath() },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'tunnel-in-use');
});

test('conflict text without the typed session error code is not a tunnel conflict', async () => {
  const result = await startLimrunHarCapture(
    {
      startTunnel: async () => {
        throw new Error('destination tunnel failed: already_active');
      },
    },
    { harPath: tempHarPath() },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'tunnel-start-failed');
});

test('a rejected selector is refused before any tunnel opens', async () => {
  let opened = false;
  const result = await startLimrunHarCapture(
    {
      startTunnel: async () => {
        opened = true;
        return {} as never;
      },
    },
    { harPath: tempHarPath(), selectors: ['not a host!!'] },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'tunnel-start-failed');
  assert.equal(opened, false);
});
