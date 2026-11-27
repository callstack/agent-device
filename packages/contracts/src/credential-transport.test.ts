import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertSecureCredentialSocket,
  assertSecureCredentialTransport,
  fetchWithCredential,
} from './credential-transport.ts';
import { isLoopbackHostname } from './loopback-host.ts';

test('loopback hostnames are recognized in each spelling a base URL carries', () => {
  expect(isLoopbackHostname('LocalHost ')).toBe(true);
  expect(isLoopbackHostname('127.0.0.1')).toBe(true);
  expect(isLoopbackHostname('[::1]')).toBe(true);
  expect(isLoopbackHostname('::ffff:127.0.0.1')).toBe(true);
  expect(isLoopbackHostname('0.0.0.0')).toBe(false);
  expect(isLoopbackHostname('127.1.2.3')).toBe(true);
  expect(isLoopbackHostname('localhost.example.test')).toBe(false);
  expect(isLoopbackHostname('')).toBe(false);
});

test.each([
  'https://fleet.example.test/agent-device',
  'https://10.0.0.7:4310',
  'http://127.0.0.1:4310/agent-device',
  'http://[::1]:4310',
  'http://localhost:4310',
])('a credential may travel to %s', (url) => {
  expect(assertSecureCredentialTransport(url, 'Remote daemon base URL').href).toBe(
    new URL(url).href,
  );
});

test.each([
  'http://fleet.example.test/agent-device',
  'http://10.0.0.7:4310',
  'http://0.0.0.0:4310',
  'http://localhost.:4310',
  'ws://127.0.0.1:4310',
  'http:',
])('a credential never travels to %s', (url) => {
  let refusal: unknown;
  try {
    assertSecureCredentialTransport(url, 'Remote daemon base URL');
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(AppError);
  expect((refusal as AppError).code).toBe('INVALID_ARGS');
  expect((refusal as AppError).details?.reason).toBe('insecure_credential_transport');
});

test.each([
  'wss://bridge.example.test/bridge?ticket=t',
  'ws://127.0.0.1:4310/bridge?ticket=t',
  'WS://[::1]:4310/bridge',
  'ws://localhost:4310/bridge',
])('a credential socket may open to %s', (url) => {
  expect(assertSecureCredentialSocket(url, 'Bridge socket URL').href).toBe(new URL(url).href);
});

test.each([
  'ws://bridge.example.test/bridge?ticket=t',
  'ws://10.0.0.7:4310/bridge',
  'http://localhost/bridge',
  'http://127.0.0.1:4310/bridge',
  'https://bridge.example.test/bridge',
  'ftp://127.0.0.1/bridge',
  'ws:',
])('a credential socket never opens to %s', (url) => {
  expect(() => assertSecureCredentialSocket(url, 'Bridge socket URL')).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'insecure_credential_transport' }),
    }),
  );
});

test.each(['http://[fd00::1]:8100/command', 'http://[fdda:2b::42]:8100'])(
  'the CoreDevice tunnel exception admits %s, and only when asked for',
  (url) => {
    expect(() => assertSecureCredentialTransport(url, 'Runner URL')).toThrow();
    expect(
      assertSecureCredentialTransport(url, 'Runner URL', { coreDeviceTunnel: true }).href,
    ).toBe(new URL(url).href);
  },
);

test.each([
  'http://[fe80::1]:8100',
  'http://[fc00::1]:8100',
  'http://[2001:db8::1]:8100',
  'http://10.0.0.7:8100',
  'http://iphone.coredevice.local:8100',
  'ws://[fd00::1]:8100',
])('the CoreDevice tunnel exception never admits %s', (url) => {
  expect(() =>
    assertSecureCredentialTransport(url, 'Runner URL', { coreDeviceTunnel: true }),
  ).toThrow();
});

/** Sends through a transport that answers each URL in `redirects` with that redirect. */
async function followRedirects(
  url: string,
  redirects: Record<string, [status: number, location: string]>,
  followHttpsOffOrigin = false,
) {
  const sent: string[] = [];
  const response = await fetchWithCredential(
    url,
    {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: 'payload',
    },
    {
      subject: 'Test URL',
      followHttpsOffOrigin,
      send: async (input, init) => {
        const headers = new Headers(init?.headers);
        const parts = [init?.method, String(input), init?.redirect, init?.body ?? '-'];
        sent.push(
          [...parts, headers.get('authorization') ?? '-', headers.get('content-type') ?? '-'].join(
            ' ',
          ),
        );
        const redirect = redirects[String(input)];
        if (!redirect) return new Response('done');
        return new Response(null, { status: redirect[0], headers: { location: redirect[1] } });
      },
    },
  );
  return { status: response.status, sent };
}

const A = 'https://a.example/start';
const first = `POST ${A} manual payload Bearer secret application/json`;

test.each([307, 308])('a same-origin %s resends the method, body and headers', async (status) => {
  expect(await followRedirects(A, { [A]: [status, '/moved'] })).toEqual({
    status: 200,
    sent: [first, 'POST https://a.example/moved manual payload Bearer secret application/json'],
  });
});

test.each([301, 302, 303])('a same-origin %s turns a POST into a GET', async (status) => {
  expect((await followRedirects(A, { [A]: [status, '/moved'] })).sent).toEqual([
    first,
    'GET https://a.example/moved manual - Bearer secret -',
  ]);
});

test.each([
  ['another origin', 'https://b.example/start'],
  ['plain http on the same host', 'http://a.example/start'],
  ['a URL with a username', 'https://operator@a.example/start'],
])('a redirect to %s is returned, never followed', async (_label, location) => {
  expect(await followRedirects(A, { [A]: [307, location] })).toEqual({
    status: 307,
    sent: [first],
  });
});

test('three same-origin redirects are followed and the fourth is returned', async () => {
  const { status, sent } = await followRedirects(A, { [A]: [307, A] });
  expect(status).toBe(307);
  expect(sent).toHaveLength(4);
});

test('a download follows https off the origin without headers, and never to plain http', async () => {
  const b = 'https://b.example/file';
  expect(
    await followRedirects(A, { [A]: [307, b], [b]: [307, 'http://b.example/file'] }, true),
  ).toEqual({ status: 307, sent: [first, `POST ${b} manual payload - -`] });
});

test('a destination the rule refuses is never sent to', async () => {
  const send = vi.fn<typeof fetch>();
  await expect(
    fetchWithCredential('http://a.example', {}, { subject: 'Test URL', send }),
  ).rejects.toMatchObject({ details: { reason: 'insecure_credential_transport' } });
  expect(send).not.toHaveBeenCalled();
});
