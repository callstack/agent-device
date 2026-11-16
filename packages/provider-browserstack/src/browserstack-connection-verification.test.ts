import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { verifyBrowserStackConnection } from './browserstack-connection-verification.ts';

const CLIENT_VERSION = '1.2.3';

const browserStackOptions = {
  username: 'browser-user',
  accessKey: 'browser-key',
  platform: 'android' as const,
  deviceName: 'Google Pixel 8',
  osVersion: '14.0',
  app: 'bs://app-id',
};

afterEach(() => vi.unstubAllGlobals());

test('BrowserStack verifies the selected resources without creating a session', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input).includes('devices')
      ? jsonResponse([
          { os: 'android', os_version: '14.0', device: 'Google Pixel 8', realMobile: true },
        ])
      : jsonResponse([{ app_name: 'sample.apk', app_version: '1.2.3', app_url: 'bs://app-id' }]),
  );
  vi.stubGlobal('fetch', fetchMock);

  const result = await verifyBrowserStackConnection(
    {
      ...browserStackOptions,
      devicesEndpoint: 'https://browserstack.test/devices',
      appsEndpoint: 'https://browserstack.test/apps',
    },
    CLIENT_VERSION,
  );

  assert.equal(result.provider, 'browserstack');
  assert.deepEqual(result.device, {
    status: 'verified',
    name: 'Google Pixel 8',
    platform: 'android',
    osVersion: '14.0',
  });
  assert.deepEqual(result.app, {
    status: 'verified',
    name: 'sample.apk',
    reference: 'bs://app-id',
    version: '1.2.3',
  });
  assert.deepEqual(
    fetchMock.mock.calls.map(([input]) => String(input)),
    ['https://browserstack.test/devices', 'https://browserstack.test/apps'],
  );
});

test('BrowserStack classifies rejected credentials without exposing them', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({}, 401)),
  );

  await assert.rejects(
    verifyBrowserStackConnection(browserStackOptions, CLIENT_VERSION),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
      assert.doesNotMatch(JSON.stringify(error), /browser-key/);
      return true;
    },
  );
});

test('BrowserStack points HTTP failures at its service status and transport failures at the network', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({}, 503)),
  );
  await assert.rejects(
    verifyBrowserStackConnection(browserStackOptions, CLIENT_VERSION),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.equal(
        (error as { details?: { hint?: string } }).details?.hint,
        'Retry connect or check the BrowserStack service status.',
      );
      return true;
    },
  );

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed');
    }),
  );
  await assert.rejects(
    verifyBrowserStackConnection(browserStackOptions, CLIENT_VERSION),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.equal(
        (error as { details?: { hint?: string } }).details?.hint,
        'Check network access to api-cloud.browserstack.com and retry connect.',
      );
      return true;
    },
  );
});

test('BrowserStack reports a non-JSON verification answer typed, with its status', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 })),
  );

  await assert.rejects(
    verifyBrowserStackConnection(browserStackOptions, CLIENT_VERSION),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'BrowserStack connection verification answer was not JSON.');
      assert.equal(error.details?.status, 200);
      assert.equal(error.details?.hint, 'Retry connect or check the BrowserStack service status.');
      return true;
    },
  );
});

test('BrowserStack verification canonicalizes the bs:// scheme and refuses an id outside its grammar', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input).includes('devices')
      ? jsonResponse([{ os: 'android', os_version: '14.0', device: 'Google Pixel 8' }])
      : jsonResponse([{ app_name: 'sample.apk', app_url: 'bs://app-id' }]),
  );
  vi.stubGlobal('fetch', fetchMock);

  const result = await verifyBrowserStackConnection(
    {
      ...browserStackOptions,
      app: 'BS://app-id',
    },
    CLIENT_VERSION,
  );
  assert.deepEqual(result.app, {
    status: 'verified',
    name: 'sample.apk',
    reference: 'bs://app-id',
  });

  fetchMock.mockClear();
  await assert.rejects(
    verifyBrowserStackConnection({ ...browserStackOptions, app: 'bs://a b' }, CLIENT_VERSION),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.message, 'BrowserStack --provider-app bs://a b is not a bs:// app id.');
      assert.deepEqual(error.details, {
        providerApp: 'bs://a b',
        hint: 'Pass <bs://app-id-or-local-path>.',
      });
      return true;
    },
  );
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('BrowserStack defers a bs app reference outside the recent upload window', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) =>
      String(input).includes('devices')
        ? jsonResponse([{ os: 'android', os_version: '14', device: 'Google Pixel 8' }])
        : jsonResponse([]),
    ),
  );

  const result = await verifyBrowserStackConnection(browserStackOptions, CLIENT_VERSION);

  assert.deepEqual(result.app, {
    status: 'configured',
    reference: 'bs://app-id',
    message:
      'App reference was not found in the 100 most recent uploads; BrowserStack validates it when creating the session.',
  });
  assert.match(
    result.verificationMessage,
    /app availability is checked when the session is created/,
  );
});

test('BrowserStack accepts an empty-object recent apps response', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) =>
      String(input).includes('devices')
        ? jsonResponse([{ os: 'android', os_version: '14', device: 'Google Pixel 8' }])
        : jsonResponse({}),
    ),
  );

  const result = await verifyBrowserStackConnection(browserStackOptions, CLIENT_VERSION);
  assert.equal(result.app.status, 'configured');
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
