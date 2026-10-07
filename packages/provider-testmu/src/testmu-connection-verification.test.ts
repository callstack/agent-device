import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { verifyTestMuConnection } from './testmu-connection-verification.ts';
import type { TestMuOptions } from './testmu-connection-verification.ts';
afterEach(() => vi.unstubAllGlobals());
function createProvider() {
  return {
    verifyConnection: async (options: TestMuOptions) =>
      await verifyTestMuConnection(options, '1.2.3'),
  };
}
function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
const testMuOptions = {
  provider: 'testmu' as const,
  username: 'lt-user',
  accessKey: 'lt-key',
  platform: 'android' as const,
  deviceName: 'Pixel 8',
  osVersion: '14',
  app: 'lt://APP1',
  devicesEndpoint: 'https://testmu.test/capability/generator?isVirtualDevice=true',
  appsEndpoint: 'https://testmu.test/app/data',
};

const testMuCatalog = {
  app: {
    devices: {
      android: {
        brands: {
          Google: [
            { name: 'Pixel 8', osVersion: ['14', '15'] },
            { name: 'Pixel 4a', osVersion: ['13'] },
          ],
        },
      },
      ios: { brands: { Apple: [{ name: 'iPhone 16', osVersion: ['18.0'] }] } },
    },
  },
};

test('TestMu verifies the virtual device and uploaded app without creating a session', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string | undefined>;
    if (String(input).includes('capability/generator')) {
      assert.equal(headers.Authorization, undefined);
      return jsonResponse(testMuCatalog);
    }
    assert.match(String(headers.Authorization), /^Basic /);
    return jsonResponse({
      data: [{ app_id: 'APP1', name: 'sample.apk', version: '1.2.3', type: 'android' }],
      metaData: { total: 1 },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await createProvider().verifyConnection(testMuOptions);

  assert.equal(result.provider, 'testmu');
  assert.equal(result.service, 'TestMu AI');
  assert.deepEqual(result.device, {
    status: 'verified',
    name: 'Pixel 8',
    platform: 'android',
    osVersion: '14',
  });
  assert.deepEqual(result.app, {
    status: 'verified',
    name: 'sample.apk',
    reference: 'lt://APP1',
    version: '1.2.3',
  });
  assert.deepEqual(
    fetchMock.mock.calls.map(([input]) => String(input)),
    [
      'https://testmu.test/capability/generator?isVirtualDevice=true',
      'https://testmu.test/app/data?type=emulator&level=user',
    ],
  );
});

test('TestMu checks the catalog of the configured API endpoint', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input).includes('capability/generator')
      ? jsonResponse(testMuCatalog)
      : jsonResponse({ data: [{ app_id: 'APP1' }] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { devicesEndpoint: _devicesEndpoint, ...options } = testMuOptions;

  await createProvider().verifyConnection({
    ...options,
    apiEndpoint: 'https://staging.testmu.test/mobile-automation/api/v1/',
  });

  assert.equal(
    String(fetchMock.mock.calls[0]?.[0]),
    'https://staging.testmu.test/mobile-automation/api/v1/capability/generator?isVirtualDevice=true',
  );
});

test('TestMu keeps the query of an overridden endpoint and adds its own filters', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input).includes('capability/generator')
      ? jsonResponse(testMuCatalog)
      : jsonResponse({ data: [{ app_id: 'APP1' }] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { devicesEndpoint: _devicesEndpoint, ...options } = testMuOptions;

  await createProvider().verifyConnection({
    ...options,
    apiEndpoint: 'https://staging.testmu.test/api/v1/?region=eu',
    appsEndpoint: 'https://staging.testmu.test/app/data?org=42',
  });
  await createProvider().verifyConnection({
    ...testMuOptions,
    devicesEndpoint: 'https://testmu.test/capability/generator?region=eu',
  });

  assert.deepEqual(
    fetchMock.mock.calls.map(([input]) => String(input)),
    [
      'https://staging.testmu.test/api/v1/capability/generator?region=eu&isVirtualDevice=true',
      'https://staging.testmu.test/app/data?org=42&type=emulator&level=user',
      'https://testmu.test/capability/generator?region=eu&isVirtualDevice=true',
      'https://testmu.test/app/data?type=emulator&level=user',
    ],
  );
});

test('TestMu rejects a device or OS version missing from the virtual-device catalog', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => jsonResponse(testMuCatalog)),
  );
  await assert.rejects(
    createProvider().verifyConnection({ ...testMuOptions, osVersion: '12' }),
    (error: unknown) =>
      error instanceof Error && /"Pixel 8" with android 12 is not available/.test(error.message),
  );
  await assert.rejects(
    createProvider().verifyConnection({ ...testMuOptions, platform: 'ios', deviceName: 'Pixel 8' }),
    /is not available/,
  );
});

// The hub rejects `platformVersion: '18'` for a catalog entry spelled `18.0`, so connect must too.
test('TestMu matches the catalog OS version spelling exactly and lists the offered versions', async () => {
  const catalog = {
    app: {
      devices: {
        ios: {
          brands: {
            Apple: [{ name: 'iPhone 16', osVersion: ['18.1', '26.0', '18.0', '18.5', '26.2'] }],
          },
        },
      },
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      String(input).includes('capability/generator')
        ? jsonResponse(catalog)
        : jsonResponse({ data: [], metaData: { total: 0 } }),
    ),
  );
  const iosOptions = { ...testMuOptions, platform: 'ios' as const, deviceName: 'iPhone 16' };

  await assert.rejects(
    createProvider().verifyConnection({ ...iosOptions, osVersion: '18' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
      assert.match(error.message, /iPhone 16 offers 18\.0, 18\.1, 18\.5, 26\.0, 26\.2/);
      return true;
    },
  );

  const result = await createProvider().verifyConnection({ ...iosOptions, osVersion: '18.0' });
  assert.deepEqual(result.device, {
    status: 'verified',
    name: 'iPhone 16',
    platform: 'ios',
    osVersion: '18.0',
  });
});

test('TestMu classifies rejected credentials without exposing them', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      String(input).includes('capability/generator')
        ? jsonResponse(testMuCatalog)
        : jsonResponse({ message: 'Unauthorized' }, 401),
    ),
  );
  await assert.rejects(createProvider().verifyConnection(testMuOptions), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
    assert.doesNotMatch(error.message, /lt-key/);
    return true;
  });
});

test('TestMu defers an lt:// reference it cannot find and a local path it will upload', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      String(input).includes('capability/generator')
        ? jsonResponse(testMuCatalog)
        : jsonResponse({ data: [], metaData: { total: 0 } }),
    ),
  );
  const unknownApp = await createProvider().verifyConnection(testMuOptions);
  assert.equal(unknownApp.app.status, 'configured');
  assert.equal(unknownApp.app.reference, 'lt://APP1');

  const localApp = await createProvider().verifyConnection({
    ...testMuOptions,
    app: '/tmp/builds/App.apk',
  });
  assert.deepEqual(localApp.app, {
    status: 'configured',
    name: 'App.apk',
    reference: '/tmp/builds/App.apk',
    message: 'Local app artifact is ready and will be uploaded when creating the session.',
  });
});

// The real-device catalog is keyed by platform at the top level, not under `app.devices`.
const testMuRealCatalog = {
  android: {
    brands: {
      Google: [
        { name: 'Pixel 6', osVersion: ['12', '13', '14', '15', '16'] },
        { name: 'Pixel 8', osVersion: ['14'] },
      ],
    },
  },
  ios: {
    brands: {
      Apple: [
        { name: 'iPhone 16', osVersion: ['18'] },
        { name: 'iPhone 15', osVersion: ['17', '18', '26'] },
      ],
    },
  },
  roku: { brands: {} },
  tvos: { brands: {} },
};

test('TestMu verifies a real device against the real-device catalog shape', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input).includes('capability/generator')
      ? jsonResponse(testMuRealCatalog)
      : jsonResponse({ data: [{ app_id: 'APP1', name: 'MyApp.ipa' }], metaData: { total: 1 } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { devicesEndpoint: _devicesEndpoint, ...defaultCatalog } = testMuOptions;

  const result = await createProvider().verifyConnection({
    ...defaultCatalog,
    deviceType: 'real',
    platform: 'ios',
    deviceName: 'iPhone 16',
    osVersion: '18',
  });

  assert.equal(result.verificationMessage, 'Credentials, real device, and uploaded app verified.');
  assert.deepEqual(result.device, {
    status: 'verified',
    name: 'iPhone 16',
    platform: 'ios',
    osVersion: '18',
  });
  assert.equal(
    String(fetchMock.mock.calls[0]?.[0]),
    'https://mobile-api.lambdatest.com/mobile-automation/api/v1/capability/generator?isVirtualDevice=false',
  );

  const android = await createProvider().verifyConnection({
    ...testMuOptions,
    deviceType: 'real',
    deviceName: 'Pixel 6',
    osVersion: '14',
  });
  assert.equal(android.device.name, 'Pixel 6');
});

// Real iOS devices are listed by major version, so `18.0` is the wrong spelling for the real pool.
test('TestMu matches real-device OS versions exactly and lists what the device offers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => jsonResponse(testMuRealCatalog)),
  );
  const realIos = {
    ...testMuOptions,
    deviceType: 'real' as const,
    platform: 'ios' as const,
    deviceName: 'iPhone 15',
  };
  await assert.rejects(
    createProvider().verifyConnection({ ...realIos, deviceName: 'iPhone 16', osVersion: '18.0' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
      assert.match(
        error.message,
        /TestMu AI real device "iPhone 16" with ios 18\.0 is not available/,
      );
      assert.match(error.message, /iPhone 16 offers 18\.$/);
      return true;
    },
  );
  await assert.rejects(
    createProvider().verifyConnection({ ...realIos, osVersion: '16' }),
    /iPhone 15 offers 17, 18, 26/,
  );
});

test('TestMu fails typed when a catalog does not have the selected pool shape', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => jsonResponse(testMuCatalog)),
  );
  await assert.rejects(
    createProvider().verifyConnection({ ...testMuOptions, deviceType: 'real' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === 'COMMAND_FAILED' &&
      /real-device catalog response did not list devices/.test(error.message),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => jsonResponse(testMuRealCatalog)),
  );
  await assert.rejects(
    createProvider().verifyConnection(testMuOptions),
    /virtual-device catalog response did not list devices/,
  );
});

// The listing is keyed by pool: `emulator`/`simulator` hold virtual uploads, `android`/`ios` real
// ones, so an id must be looked up in the list of the pool the session will run on.
test('TestMu checks an lt:// id against the app list of the selected pool and platform', async () => {
  const cases = [
    { deviceType: 'virtual', platform: 'android', deviceName: 'Pixel 8', listType: 'emulator' },
    { deviceType: 'virtual', platform: 'ios', deviceName: 'iPhone 16', listType: 'simulator' },
    { deviceType: 'real', platform: 'android', deviceName: 'Pixel 6', listType: 'android' },
    { deviceType: 'real', platform: 'ios', deviceName: 'iPhone 16', listType: 'ios' },
  ] as const;
  for (const { deviceType, platform, deviceName, listType } of cases) {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('capability/generator')) {
        return jsonResponse(deviceType === 'real' ? testMuRealCatalog : testMuCatalog);
      }
      return jsonResponse({
        data: new URL(url).searchParams.get('type') === listType ? [{ app_id: 'APP1' }] : [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await createProvider().verifyConnection({
      ...testMuOptions,
      deviceType,
      platform,
      deviceName,
      osVersion:
        deviceType === 'real'
          ? platform === 'ios'
            ? '18'
            : '14'
          : platform === 'ios'
            ? '18.0'
            : '14',
    });
    assert.equal(result.app.status, 'verified', `${deviceType} ${platform}`);
    assert.equal(
      String(fetchMock.mock.calls[1]?.[0]),
      `https://testmu.test/app/data?type=${listType}&level=user`,
    );
  }
});

test('TestMu defers a real-device lt:// id missing from the real-device app list', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      String(input).includes('capability/generator')
        ? jsonResponse(testMuRealCatalog)
        : jsonResponse({ data: [], metaData: { total: 0 } }),
    ),
  );
  const result = await createProvider().verifyConnection({
    ...testMuOptions,
    deviceType: 'real',
    deviceName: 'Pixel 6',
  });
  assert.equal(result.app.status, 'configured');
  assert.match(String(result.app.message), /not found among your real-device uploads/);
  assert.equal(
    result.verificationMessage,
    'Credentials and real device verified; app availability is checked when the session is created.',
  );
});
