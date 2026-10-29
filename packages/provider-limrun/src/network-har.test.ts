import assert from 'node:assert/strict';
import { test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { DestinationTunnelInspectionEvent } from '@limrun/api/destination-tunnel-inspection';
import { DestinationTunnelSessionError } from '@limrun/api/destination-tunnel-dialer';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { DEFAULT_LIMRUN_HAR_SELECTORS, startLimrunHarCapture } from './network-har.ts';

function harEntry(url: string, error?: string): DestinationTunnelInspectionEvent {
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
      response: {
        status: 200,
        statusText: 'OK',
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

function fakeTunnelClient(lastDialFailure?: {
  tunnelId: string;
  selectorId: string;
  reason: string;
  osCode?: string;
}) {
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
          close: () => {},
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

test('a completed inspection event lands in a valid HAR document', async () => {
  const fake = fakeTunnelClient();
  const harPath = tempHarPath();
  const result = await startLimrunHarCapture(fake.client, { harPath });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const emit = fake.started[0]?.onEvent;
  assert.ok(emit);
  emit(harEntry('https://example.com/a'));
  emit(harEntry('https://example.com/b'));

  const document = JSON.parse(fs.readFileSync(harPath, 'utf8')) as {
    log: { version: string; entries: unknown[] };
  };
  assert.equal(document.log.version, '1.2');
  assert.equal(document.log.entries.length, 2);

  result.capture.close();
  const final = JSON.parse(fs.readFileSync(result.capture.harPath, 'utf8')) as {
    log: { entries: unknown[] };
  };
  assert.equal(final.log.entries.length, 2);
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
  const document = JSON.parse(fs.readFileSync(result.capture.harPath, 'utf8')) as {
    log: { entries: unknown[] };
  };
  assert.equal(document.log.entries.length, 2);
  result.capture.close();
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
  result.capture.close();
});

test("another tunnel's dial failure is not reported as this capture's", async () => {
  const fake = fakeTunnelClient({ tunnelId: 'older', selectorId: 's1', reason: 'client_timeout' });
  const result = await startLimrunHarCapture(fake.client, { harPath: tempHarPath() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const report = await result.capture.failures();
  assert.equal(report.total, 0);
  assert.equal(report.lastDialFailure, undefined);
  result.capture.close();
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
