import { afterEach, expect, test, vi } from 'vitest';
import { formatCloudVendorRow, listCloudVendors } from './cloud-catalog.ts';

const baseUrl = 'https://cloud.example';
const legacyRow = {
  vendor: 'provider-b',
  platform: 'android',
  usdPerMinute: 0.04,
  capabilities: ['adb'],
  viewer: true,
  available: true,
  catalogVersion: 3,
  maxMinutes: 115,
};
const checkedAt = '2026-11-22T12:00:00.000Z';
const liveAvailability = {
  state: 'unavailable',
  reason: 'sessions_paused',
  checkedAt,
  scope: 'broker_vendor',
} as const;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubVendors(body: unknown) {
  const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => Response.json(body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestOf(fetchMock: ReturnType<typeof stubVendors>) {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url, init, headers: new Headers(init.headers) };
}

test('a static listing returns older-server rows unchanged and sends the API key', async () => {
  const fetchMock = stubVendors([legacyRow]);
  expect(await listCloudVendors(baseUrl, 'example-key')).toEqual([legacyRow]);
  const { url, init, headers } = requestOf(fetchMock);
  expect(url.href).toBe('https://cloud.example/v1/vendors');
  expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  expect(headers.get('authorization')).toBe('Bearer example-key');
});

test('a static listing reads the optional price and minimum fields and keeps unknown fields', async () => {
  const row = { ...legacyRow, usdMicrosPerMinute: '40000', minMinutes: 5, future: { a: 1 } };
  stubVendors([row]);
  expect(await listCloudVendors(baseUrl, 'example-key')).toEqual([row]);
});

test('a price in micro-USD may be as wide as the widest --max-usd cap', async () => {
  const row = { ...legacyRow, usdMicrosPerMinute: '9999999999999999999' };
  stubVendors([row]);
  expect(await listCloudVendors(baseUrl, 'example-key')).toEqual([row]);
});

test.each([
  ['a non-array body', { vendors: [] }],
  ['a row without a vendor', [{ ...legacyRow, vendor: '' }]],
  ['a fractional price in micro-USD', [{ ...legacyRow, usdMicrosPerMinute: '0.04' }]],
  ['a numeric price in micro-USD', [{ ...legacyRow, usdMicrosPerMinute: 40000 }]],
  ['a signed price in micro-USD', [{ ...legacyRow, usdMicrosPerMinute: '-1' }]],
  ['a zero minimum', [{ ...legacyRow, minMinutes: 0 }]],
  ['a fractional minimum', [{ ...legacyRow, minMinutes: 2.5 }]],
  ['a text minimum', [{ ...legacyRow, minMinutes: '5' }]],
])('rejects %s as an invalid vendor list', async (_name, body) => {
  stubVendors(body);
  await expect(listCloudVendors(baseUrl, 'example-key')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Cloud session API returned an invalid vendor list.',
  });
});

test('a live listing asks for fresh availability with the API key and returns the signal', async () => {
  const fetchMock = stubVendors([{ ...legacyRow, availability: liveAvailability }]);
  const rows = await listCloudVendors(baseUrl, 'example-key', { live: true });
  expect(rows).toEqual([{ ...legacyRow, availability: liveAvailability }]);
  const { url, init, headers } = requestOf(fetchMock);
  expect(url.href).toBe('https://cloud.example/v1/vendors?availability=live');
  expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  expect(headers.get('authorization')).toBe('Bearer example-key');
});

test('a live listing marks rows from a server without the signal as unknown', async () => {
  vi.setSystemTime(new Date('2026-11-22T12:30:00.000Z'));
  stubVendors([legacyRow, { ...legacyRow, platform: 'ios', availability: liveAvailability }]);
  const rows = await listCloudVendors(baseUrl, 'example-key', { live: true });
  expect(rows[0]!.availability).toEqual({
    state: 'unknown',
    reason: 'live_availability_unsupported',
    checkedAt: '2026-11-22T12:30:00.000Z',
    scope: 'broker_vendor',
  });
  expect(rows[1]!.availability).toEqual(liveAvailability);
  expect(rows[0]).toMatchObject(legacyRow);
});

test('a static listing leaves a row without availability alone', async () => {
  stubVendors([legacyRow]);
  const [row] = await listCloudVendors(baseUrl, 'example-key', { live: false });
  expect(row).not.toHaveProperty('availability');
});

test.each([
  ['an unknown state', { ...liveAvailability, state: 'busy' }],
  ['an unknown reason', { ...liveAvailability, reason: 'on_fire' }],
  ['a non-vendor scope', { ...liveAvailability, scope: 'model' }],
  ['a missing timestamp', { state: 'available', scope: 'broker_vendor' }],
  ['an unparseable timestamp', { ...liveAvailability, checkedAt: 'yesterday' }],
  ['a non-object signal', 'available'],
])('a live listing rejects %s', async (_name, availability) => {
  stubVendors([{ ...legacyRow, availability }]);
  await expect(listCloudVendors(baseUrl, 'example-key', { live: true })).rejects.toMatchObject({
    message: 'Cloud session API returned an invalid vendor list.',
  });
});

test('a live listing keeps an available signal that carries no reason', async () => {
  const availability = { state: 'available', checkedAt, scope: 'broker_vendor' } as const;
  stubVendors([{ ...legacyRow, availability }]);
  const [row] = await listCloudVendors(baseUrl, 'example-key', { live: true });
  expect(row!.availability).toEqual(availability);
});

test('reports a rejected request and an unreachable server without raw response text', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('secret upstream detail', { status: 503 })),
  );
  const rejected = await listCloudVendors(baseUrl, 'example-key', { live: true }).catch(
    (error: Error) => error,
  );
  expect(rejected).toMatchObject({ code: 'COMMAND_FAILED' });
  expect((rejected as Error).message).not.toContain('secret upstream detail');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED');
    }),
  );
  await expect(listCloudVendors(baseUrl, 'example-key')).rejects.toMatchObject({
    message: 'Could not reach the cloud session API.',
  });
});

test('text rows keep the legacy shape and add the minimum and live availability when present', () => {
  expect(formatCloudVendorRow(legacyRow)).toBe(
    'provider-b android  $0.04/min  capabilities: adb  live view: yes  available: yes',
  );
  expect(
    formatCloudVendorRow({
      ...legacyRow,
      minMinutes: 5,
      available: false,
      availability: liveAvailability,
    }),
  ).toBe(
    'provider-b android  $0.04/min  minimum: 5 min  capabilities: adb  live view: yes  available: no  availability: unavailable (sessions_paused)',
  );
  expect(
    formatCloudVendorRow({
      ...legacyRow,
      availability: { state: 'available', checkedAt, scope: 'broker_vendor' },
    }),
  ).toMatch(/ {2}availability: available$/);
});
