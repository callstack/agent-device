import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  verifySauceLabsConnection,
  type SauceLabsConnectionVerificationOptions,
} from './saucelabs-connection-verification.ts';

const CLIENT_VERSION = '1.2.3';
const FILE_ID = '0b6a3f52-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const API = 'https://api.eu-central-1.saucelabs.com';

const OPTIONS: SauceLabsConnectionVerificationOptions = {
  username: 'sauce-user',
  accessKey: 'sauce-key',
  region: 'eu-central-1',
  platform: 'android',
  deviceName: 'Google Pixel 8',
  osVersion: '14',
  app: `storage:${FILE_ID}`,
};

const DEVICES = [
  { id: 'Google_Pixel_8_14_real', name: 'Google Pixel 8', os: 'ANDROID', osVersion: '14' },
  { id: 'Google_Pixel_8_15_real', name: 'Google Pixel 8', os: 'ANDROID', osVersion: '15.0.1' },
  { id: 'Google_Pixel_8_Pro_15_real', name: 'Google Pixel 8 Pro', os: 'ANDROID', osVersion: '15' },
  { id: 'iPhone_15_17_real', name: 'iPhone 15', os: 'IOS', osVersion: '17.5' },
];

function storageFile(overrides: Record<string, unknown> = {}) {
  return {
    id: FILE_ID,
    name: 'app-release.apk',
    kind: 'android',
    upload_timestamp: 100,
    metadata: { identifier: 'com.example.app', version: '2.4.0' },
    ...overrides,
  };
}

/** Answers the device catalog, and storage from `pages` in order, with `links.next` on all but the last. */
function stubSauceLabs(pages: unknown[][] = [[storageFile()]]) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/rdc/devices') return jsonResponse(DEVICES);
    const page = Number(url.searchParams.get('page') ?? '1');
    const items = pages[page - 1] ?? [];
    return jsonResponse({
      items,
      links: { next: page < pages.length ? `?page=${String(page + 1)}` : null },
      total_items: pages.flat().length,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

test('Sauce Labs verifies the device, OS, and storage upload without creating a session', async () => {
  const fetchMock = stubSauceLabs();

  const result = await verifySauceLabsConnection(OPTIONS, CLIENT_VERSION);

  assert.equal(result.provider, 'saucelabs');
  assert.deepEqual(result.device, {
    status: 'verified',
    name: 'Google Pixel 8',
    reference: 'Google_Pixel_8_14_real',
    platform: 'android',
    osVersion: '14',
  });
  assert.deepEqual(result.app, {
    status: 'verified',
    name: 'app-release.apk',
    reference: `storage:${FILE_ID}`,
    version: '2.4.0',
  });
  assert.deepEqual(
    fetchMock.mock.calls.map(([input]) => String(input)),
    [`${API}/v1/rdc/devices`, `${API}/v1/storage/files?file_id=${FILE_ID}`],
  );
  assert.equal(
    new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization'),
    `Basic ${Buffer.from('sauce-user:sauce-key').toString('base64')}`,
  );
});

test('Sauce Labs matches a device by id, by a name pattern, and by an OS version prefix', async () => {
  stubSauceLabs();
  const byId = await verifySauceLabsConnection(
    { ...OPTIONS, deviceName: 'Google_Pixel_8_15_real', osVersion: undefined },
    CLIENT_VERSION,
  );
  assert.equal(byId.device.reference, 'Google_Pixel_8_15_real');
  assert.equal(byId.device.osVersion, '15.0.1');

  const byPrefix = await verifySauceLabsConnection({ ...OPTIONS, osVersion: '15' }, CLIENT_VERSION);
  assert.equal(byPrefix.device.reference, 'Google_Pixel_8_15_real');

  const byPattern = await verifySauceLabsConnection(
    { ...OPTIONS, deviceName: 'google pixel 8.*', osVersion: '15' },
    CLIENT_VERSION,
  );
  assert.equal(byPattern.device.name, 'google pixel 8.*');
  assert.equal(byPattern.device.message, '2 devices match; Sauce Labs picks a free one.');
});

test('Sauce Labs refuses a device it does not list for the platform and OS, with a typed reason', async () => {
  stubSauceLabs();
  for (const options of [
    { ...OPTIONS, deviceName: 'Google Pixel 99' },
    { ...OPTIONS, osVersion: '1' },
    { ...OPTIONS, deviceName: 'iPhone 15' },
    // A pattern that does not compile matches by exact name only.
    { ...OPTIONS, deviceName: 'Google Pixel 8 (' },
  ]) {
    await assert.rejects(verifySauceLabsConnection(options, CLIENT_VERSION), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.details?.reason, 'saucelabs_device_not_found');
      assert.equal(error.details?.region, 'eu-central-1');
      return true;
    });
  }
});

test('storage:filename= follows the name search pages and takes the newest exact match', async () => {
  const newest = '1c6a3f52-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const fetchMock = stubSauceLabs([
    [
      storageFile({ upload_timestamp: 100 }),
      storageFile({ name: 'APP-RELEASE.apk', upload_timestamp: 900 }),
    ],
    [storageFile({ id: newest, upload_timestamp: 300, metadata: { version: '2.5.0' } })],
  ]);

  const result = await verifySauceLabsConnection(
    { ...OPTIONS, app: 'storage:filename=app-release.apk' },
    CLIENT_VERSION,
  );

  assert.deepEqual(result.app, {
    status: 'verified',
    name: 'app-release.apk',
    reference: 'storage:filename=app-release.apk',
    version: '2.5.0',
  });
  const lookups = fetchMock.mock.calls.slice(1).map(([input]) => new URL(String(input)));
  assert.deepEqual(
    lookups.map((url) => [url.searchParams.get('name'), url.searchParams.get('page')]),
    [
      ['app-release.apk', '1'],
      ['app-release.apk', '2'],
    ],
  );
});

test('storage:filename= with no exact match stays configured for the hub to resolve', async () => {
  stubSauceLabs([[storageFile({ name: 'other.apk' })]]);
  const result = await verifySauceLabsConnection(
    { ...OPTIONS, app: 'storage:filename=app-release.apk' },
    CLIENT_VERSION,
  );
  assert.equal(result.app.status, 'configured');
  assert.equal(result.app.reference, 'storage:filename=app-release.apk');
});

test('Sauce Labs refuses a missing file id, another platform, a non-app kind, and a simulator build', async () => {
  const cases: Array<[unknown[], Partial<typeof OPTIONS>, string]> = [
    [[], {}, 'saucelabs_app_not_found'],
    [[storageFile({ kind: 'IOS', name: 'app.ipa' })], {}, 'saucelabs_app_platform_mismatch'],
    [[storageFile({ kind: 'other', name: 'tests.zip' })], {}, 'saucelabs_app_kind_unsupported'],
    [
      [storageFile({ kind: 'ios', name: 'app.zip', metadata: { is_simulator: true } })],
      { platform: 'ios', deviceName: 'iPhone 15', osVersion: '17' },
      'saucelabs_app_simulator_build',
    ],
  ];
  for (const [files, options, reason] of cases) {
    stubSauceLabs([files]);
    await assert.rejects(
      verifySauceLabsConnection({ ...OPTIONS, ...options }, CLIENT_VERSION),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.equal(error.details?.reason, reason);
        return true;
      },
      reason,
    );
  }
});

test('Sauce Labs configures an https URL and a local artifact without a storage lookup', async () => {
  const fetchMock = stubSauceLabs();
  const url = await verifySauceLabsConnection(
    { ...OPTIONS, app: 'https://example.test/app.apk' },
    CLIENT_VERSION,
  );
  assert.equal(url.app.status, 'configured');
  const local = await verifySauceLabsConnection(
    { ...OPTIONS, app: '/builds/app.apk' },
    CLIENT_VERSION,
  );
  assert.deepEqual(
    { status: local.app.status, name: local.app.name },
    { status: 'configured', name: 'app.apk' },
  );
  assert.equal(
    fetchMock.mock.calls.filter(([input]) => String(input).includes('storage')).length,
    0,
  );
});

test('Sauce Labs classifies rejected credentials without exposing them', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ detail: 'Authorization failed' }, 401)),
  );

  await assert.rejects(verifySauceLabsConnection(OPTIONS, CLIENT_VERSION), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'UNAUTHORIZED');
    assert.match(String(error.details?.hint), /SAUCE_USERNAME and SAUCE_ACCESS_KEY/);
    assert.doesNotMatch(JSON.stringify(error), /sauce-key/);
    return true;
  });
});

test('Sauce Labs verification calls the API of the selected data center', async () => {
  const fetchMock = stubSauceLabs();
  await verifySauceLabsConnection({ ...OPTIONS, region: 'us-east-4' }, CLIENT_VERSION);
  assert.equal(
    String(fetchMock.mock.calls[0]?.[0]),
    'https://api.us-east-4.saucelabs.com/v1/rdc/devices',
  );
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
