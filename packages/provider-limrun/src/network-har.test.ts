import assert from 'node:assert/strict';
import { test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { DestinationTunnelInspectionEvent } from '@limrun/api/destination-tunnel-inspection';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { DEFAULT_LIMRUN_HAR_SELECTORS, startLimrunHarCapture } from './network-har.ts';

function harEntry(url: string): DestinationTunnelInspectionEvent {
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
      _limrun: { tunnelId: 't1', selectorId: 's1' },
    },
  } as unknown as DestinationTunnelInspectionEvent;
}

function fakeTunnelClient() {
  const started: {
    selectors: string[];
    onEvent?: (e: DestinationTunnelInspectionEvent) => void;
  }[] = [];
  return {
    started,
    client: {
      startTunnel: async (options: {
        selectors: string[];
        onInspectionEvent?: (event: DestinationTunnelInspectionEvent) => void;
      }) => {
        started.push({ selectors: options.selectors, onEvent: options.onInspectionEvent });
        return {
          tunnelId: 't1',
          close: () => {},
        } as never;
      },
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

test('a tunnel conflict is reported as a typed refusal, not a crash', async () => {
  const harPath = tempHarPath();
  const result = await startLimrunHarCapture(
    {
      startTunnel: async () => {
        throw new Error('tunnel already_active for this instance');
      },
    },
    { harPath },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'tunnel-in-use');
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
