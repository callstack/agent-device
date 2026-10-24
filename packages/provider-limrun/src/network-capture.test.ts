import { describe, expect, test } from 'vitest';
import { DestinationTunnelSessionError } from '@limrun/api/destination-tunnel-dialer';
import type { DestinationTunnelInspectionEvent } from '@limrun/api/destination-tunnel-inspection';
import type { DestinationTcpTunnel } from '@limrun/api/destination-tunnel-dialer';
import {
  createLimrunNetworkCapture,
  DEFAULT_LIMRUN_CAPTURE_HOSTS,
  type LimrunTunnelClient,
} from './network-capture.ts';

/** One fake tunnel client: it records what a start asked for and hands events back on demand. */
function fakeTunnelClient(
  onStart: (emit: (event: DestinationTunnelInspectionEvent) => void) => void = () => {},
  open: (options: Parameters<LimrunTunnelClient['startTunnel']>[0]) => DestinationTcpTunnel = () =>
    ({ close: () => {} }) as unknown as DestinationTcpTunnel,
): Readonly<{ client: LimrunTunnelClient; starts: Array<Record<string, unknown>> }> {
  const starts: Array<Record<string, unknown>> = [];
  return {
    starts,
    client: {
      startTunnel: async (options) => {
        starts.push(options as unknown as Record<string, unknown>);
        onStart(options.onInspectionEvent ?? (() => {}));
        return open(options);
      },
    },
  };
}

function completeEvent(
  url: string,
  overrides: {
    method?: string;
    status?: number;
    time?: number;
    error?: string;
    requestHeaders?: Array<{ name: string; value: string }>;
    responseBody?: string;
  } = {},
): DestinationTunnelInspectionEvent {
  return {
    type: 'complete',
    sequence: 1,
    requestId: 'r1',
    data: {
      startedDateTime: '2026-10-24T10:00:00.000Z',
      time: overrides.time ?? 42,
      request: {
        method: overrides.method ?? 'GET',
        url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: overrides.requestHeaders ?? [{ name: 'accept', value: 'application/json' }],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: overrides.status ?? 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [{ name: 'content-type', value: 'application/json' }],
        content: {
          size: overrides.responseBody?.length ?? 0,
          mimeType: 'application/json',
          text: overrides.responseBody,
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: { send: 1, wait: 40, receive: 1 },
      _limrun: {
        tunnelId: 'tun_1',
        selectorId: 'sel_1',
        requestBodyTruncated: false,
        responseBodyTruncated: false,
        ...(overrides.error ? { error: overrides.error } : {}),
      },
    },
  } as unknown as DestinationTunnelInspectionEvent;
}

describe('Limrun network capture start', () => {
  test('defaults to the measured public-TLD wildcards and enables inspection with bodies', async () => {
    const { client, starts } = fakeTunnelClient();
    const capture = createLimrunNetworkCapture(client);

    const started = await capture.start(undefined);

    expect(started).toEqual({
      ok: true,
      hosts: DEFAULT_LIMRUN_CAPTURE_HOSTS,
      capturingBodies: true,
    });
    expect(starts[0]).toMatchObject({ selectors: [...DEFAULT_LIMRUN_CAPTURE_HOSTS] });
    expect(starts[0]).toHaveProperty('inspection', {
      enabled: true,
      captureBodies: true,
      maxBodyBytes: 2 * 1024 * 1024,
    });
    expect(capture.running).toBe(true);
  });

  test('an operator host list replaces the defaults instead of extending them', async () => {
    const { client, starts } = fakeTunnelClient();
    const capture = createLimrunNetworkCapture(client);

    const started = await capture.start(['api.example.com']);

    expect(started).toMatchObject({ ok: true, hosts: ['api.example.com'] });
    expect(starts[0]).toMatchObject({ selectors: ['api.example.com'] });
  });

  test('refuses a second start while the first capture still runs', async () => {
    const { client } = fakeTunnelClient();
    const capture = createLimrunNetworkCapture(client);
    await capture.start(undefined);

    const second = await capture.start(undefined);

    expect(second).toMatchObject({ ok: false, reason: 'tunnel-in-use' });
  });

  test('refuses blank selectors without opening a tunnel', async () => {
    const { client, starts } = fakeTunnelClient();
    const capture = createLimrunNetworkCapture(client);

    const started = await capture.start(['   ']);

    expect(started).toMatchObject({ ok: false, reason: 'unsupported-device' });
    expect(starts).toHaveLength(0);
    expect(capture.running).toBe(false);
  });

  test('a Limrun already_active refusal is reported as a busy tunnel', async () => {
    const { client } = fakeTunnelClient(undefined, () => {
      throw new DestinationTunnelSessionError('already_active');
    });
    const capture = createLimrunNetworkCapture(client);

    const started = await capture.start(undefined);

    expect(started).toMatchObject({ ok: false, reason: 'tunnel-in-use' });
    expect(capture.running).toBe(false);
  });

  test('an unclassified start failure stays a generic unsupported-device refusal', async () => {
    const { client } = fakeTunnelClient(undefined, () => {
      throw new Error('tunnel endpoint refused');
    });
    const capture = createLimrunNetworkCapture(client);

    const started = await capture.start(undefined);

    expect(started).toMatchObject({ ok: false, reason: 'unsupported-device' });
  });
});

describe('Limrun network capture entries', () => {
  test('maps a completed HAR entry to method, url, status, duration, and timestamp', async () => {
    let emit!: (event: DestinationTunnelInspectionEvent) => void;
    const { client } = fakeTunnelClient((handler) => {
      emit = handler;
    });
    const capture = createLimrunNetworkCapture(client);
    await capture.start(undefined);

    emit(completeEvent('https://api.example.com/v1/orders', { status: 201, time: 133.6 }));

    const [entry] = capture.readEntries({ maxEntries: 10, include: 'summary' });
    expect(entry).toMatchObject({
      method: 'GET',
      url: 'https://api.example.com/v1/orders',
      status: 201,
      durationMs: 134,
      timestamp: '2026-10-24T10:00:00.000Z',
    });
    // Summary mode keeps bodies and headers out of the answer.
    expect(entry?.headers).toBeUndefined();
    expect(entry?.responseBody).toBeUndefined();
  });

  test('include modes open headers and bodies on request only', async () => {
    let emit!: (event: DestinationTunnelInspectionEvent) => void;
    const { client } = fakeTunnelClient((handler) => {
      emit = handler;
    });
    const capture = createLimrunNetworkCapture(client);
    await capture.start(undefined);
    emit(
      completeEvent('https://api.example.com/v1/orders', {
        responseBody: '{"ok":true}',
        requestHeaders: [{ name: 'accept', value: 'application/json' }],
      }),
    );

    const [summary] = capture.readEntries({ maxEntries: 10, include: 'summary' });
    const [withHeaders] = capture.readEntries({ maxEntries: 10, include: 'headers' });
    const [withBodies] = capture.readEntries({ maxEntries: 10, include: 'body' });
    const [withAll] = capture.readEntries({ maxEntries: 10, include: 'all' });

    expect(withHeaders?.headers).toContain('"accept":"application/json"');
    expect(withHeaders?.responseBody).toBeUndefined();
    expect(withBodies?.responseBody).toBe('{"ok":true}');
    expect(withBodies?.headers).toBeUndefined();
    expect(withAll?.headers).toBeDefined();
    expect(withAll?.responseBody).toBe('{"ok":true}');
    expect(summary?.headers).toBeUndefined();
  });

  test('redacts a credential carried in a captured header', async () => {
    let emit!: (event: DestinationTunnelInspectionEvent) => void;
    const { client } = fakeTunnelClient((handler) => {
      emit = handler;
    });
    const capture = createLimrunNetworkCapture(client);
    await capture.start(undefined);
    emit(
      completeEvent('https://api.example.com/v1/orders', {
        requestHeaders: [{ name: 'authorization', value: 'Bearer super-secret-token' }],
      }),
    );

    const [entry] = capture.readEntries({ maxEntries: 10, include: 'all' });

    expect(entry?.headers).not.toContain('super-secret-token');
    expect(entry?.headers).toContain('[REDACTED]');
  });

  test('newest entries answer first and the buffer stays bounded', async () => {
    let emit!: (event: DestinationTunnelInspectionEvent) => void;
    const { client } = fakeTunnelClient((handler) => {
      emit = handler;
    });
    const capture = createLimrunNetworkCapture(client);
    await capture.start(undefined);
    for (let index = 0; index < 205; index += 1) {
      emit(completeEvent(`https://api.example.com/v1/item/${index}`));
    }

    const entries = capture.readEntries({ maxEntries: 500, include: 'summary' });
    expect(entries).toHaveLength(200);
    expect(entries[0]?.url).toBe('https://api.example.com/v1/item/204');
  });

  test('a failed entry names its host in a note instead of an entry', async () => {
    let emit!: (event: DestinationTunnelInspectionEvent) => void;
    const { client } = fakeTunnelClient((handler) => {
      emit = handler;
    });
    const capture = createLimrunNetworkCapture(client);
    await capture.start(undefined);
    emit(
      completeEvent('https://pinned.example.com/v1/me', {
        error: 'TLS handshake rejected: certificate pinning failure',
      }),
    );

    expect(capture.readEntries({ maxEntries: 10, include: 'summary' })).toHaveLength(0);
    const notes = capture.notes();
    expect(notes.join('\n')).toContain('pinned.example.com');
    expect(notes.join('\n')).toMatch(/certificate-pinned/i);
  });

  test('an inspection gap is reported as a note', async () => {
    let emit!: (event: DestinationTunnelInspectionEvent) => void;
    const { client } = fakeTunnelClient((handler) => {
      emit = handler;
    });
    const capture = createLimrunNetworkCapture(client);
    await capture.start(undefined);
    emit({
      type: 'gap',
      sequence: 9,
      data: { fromSequence: 4, toSequence: 8, message: 'inspection stream gap' },
    } as unknown as DestinationTunnelInspectionEvent);

    expect(capture.notes().join('\n')).toContain('inspection');
  });
});

describe('Limrun network capture stop', () => {
  test('closes the tunnel, clears the buffer, and reports whether one was running', async () => {
    let emit!: (event: DestinationTunnelInspectionEvent) => void;
    let closed = false;
    const { client } = fakeTunnelClient(
      (handler) => {
        emit = handler;
      },
      () =>
        ({
          close: () => {
            closed = true;
          },
        }) as unknown as DestinationTcpTunnel,
    );
    const capture = createLimrunNetworkCapture(client);
    await capture.start(undefined);
    emit(completeEvent('https://api.example.com/v1/orders'));

    expect(await capture.stop()).toEqual({ stopped: true });
    expect(closed).toBe(true);
    expect(capture.running).toBe(false);
    expect(capture.readEntries({ maxEntries: 10, include: 'summary' })).toHaveLength(0);
    expect(await capture.stop()).toEqual({ stopped: false });
  });

  test('a stopped capture can start again', async () => {
    const { client, starts } = fakeTunnelClient();
    const capture = createLimrunNetworkCapture(client);
    await capture.start(undefined);
    await capture.stop();

    expect(await capture.start(['api.example.com'])).toMatchObject({ ok: true });
    expect(starts).toHaveLength(2);
  });
});
