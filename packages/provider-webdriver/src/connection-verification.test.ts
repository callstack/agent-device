import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createProviderWebDriver } from './index.ts';
import type { RunHostCommand } from './dependencies.ts';

const browserStackOptions = {
  provider: 'browserstack' as const,
  username: 'browser-user',
  accessKey: 'browser-key',
  platform: 'android' as const,
  deviceName: 'Google Pixel 8',
  osVersion: '14.0',
  app: 'bs://app-id',
};

const awsResources = {
  project: { arn: 'project-arn', name: 'Agent Device' },
  device: {
    arn: 'device-arn',
    name: 'Google Pixel 8',
    platform: 'ANDROID',
    os: '14',
    availability: 'HIGHLY_AVAILABLE',
  },
  upload: {
    arn: 'app-arn',
    name: 'sample.apk',
    type: 'ANDROID_APP',
    status: 'SUCCEEDED',
  },
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

  const result = await createProvider().verifyConnection({
    ...browserStackOptions,
    devicesEndpoint: 'https://browserstack.test/devices',
    appsEndpoint: 'https://browserstack.test/apps',
  });

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

  await assert.rejects(createProvider().verifyConnection(browserStackOptions), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
    assert.doesNotMatch(JSON.stringify(error), /browser-key/);
    return true;
  });
});

test('BrowserStack points HTTP failures at its service status and transport failures at the network', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({}, 503)),
  );
  await assert.rejects(createProvider().verifyConnection(browserStackOptions), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
    assert.equal(
      (error as { details?: { hint?: string } }).details?.hint,
      'Retry connect or check the BrowserStack service status.',
    );
    return true;
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed');
    }),
  );
  await assert.rejects(createProvider().verifyConnection(browserStackOptions), (error: unknown) => {
    assert.equal(
      (error as { details?: { hint?: string } }).details?.hint,
      'Check network access to api-cloud.browserstack.com and retry connect.',
    );
    return true;
  });
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

  const result = await createProvider().verifyConnection(browserStackOptions);

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

  const result = await createProvider().verifyConnection(browserStackOptions);
  assert.equal(result.app.status, 'configured');
});

test('AWS Device Farm verifies resources without creating a remote access session', async () => {
  const concurrency = { active: 0, max: 0 };
  const runHostCommand = createAwsRunner(awsResources, concurrency);
  const result = await createProvider(runHostCommand).verifyConnection({
    provider: 'aws-device-farm',
    platform: 'android',
    projectArn: 'project-arn',
    deviceArn: 'device-arn',
    appArn: 'app-arn',
    region: 'us-west-2',
  });

  assert.equal(result.provider, 'aws-device-farm');
  if (result.provider !== 'aws-device-farm') return;
  assert.deepEqual(result.project, { name: 'Agent Device', reference: 'project-arn' });
  assert.equal(result.device.name, 'Google Pixel 8');
  assert.equal(result.app.name, 'sample.apk');
  assert.deepEqual(
    runHostCommand.mock.calls.map(([, args]) => args[1]),
    ['get-project', 'get-device', 'get-upload'],
  );
  assert.equal(
    runHostCommand.mock.calls.some(([, args]) => args.includes('create-remote-access-session')),
    false,
  );
  assert.equal(concurrency.max, 3);
});

test('AWS Device Farm reports an unattached app without pretending it is installed', async () => {
  const runHostCommand = createAwsRunner({
    project: awsResources.project,
    device: { ...awsResources.device, platform: 'IOS', name: 'iPhone 15', os: '17' },
  });
  const result = await createProvider(runHostCommand).verifyConnection({
    provider: 'aws-device-farm',
    platform: 'ios',
    projectArn: 'project-arn',
    deviceArn: 'device-arn',
  });

  assert.equal(result.app.status, 'missing');
  assert.match(result.app.message ?? '', /--aws-app-arn/);
  assert.equal(runHostCommand.mock.calls.length, 2);
});

test('AWS Device Farm rejects a device from the wrong platform before allocation', async () => {
  const runHostCommand = createAwsRunner({
    project: awsResources.project,
    device: { ...awsResources.device, platform: 'IOS', name: 'iPhone 15', os: '17' },
  });

  await assert.rejects(
    createProvider(runHostCommand).verifyConnection({
      provider: 'aws-device-farm',
      platform: 'android',
      projectArn: 'project-arn',
      deviceArn: 'device-arn',
    }),
    /is ios, not android/,
  );
  assert.equal(
    runHostCommand.mock.calls.some(([, args]) => args.includes('create-remote-access-session')),
    false,
  );
});

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

function createProvider(runHostCommand: RunHostCommand = vi.fn()) {
  return createProviderWebDriver({ clientVersion: '1.2.3', runHostCommand });
}

function createAwsRunner(
  resources: Partial<typeof awsResources>,
  concurrency?: { active: number; max: number },
) {
  return vi.fn<RunHostCommand>(async (_command, args) => {
    if (concurrency) {
      concurrency.active += 1;
      concurrency.max = Math.max(concurrency.max, concurrency.active);
    }
    await Promise.resolve();
    try {
      const resource = resources[String(args[1]).replace('get-', '') as keyof typeof awsResources];
      if (!resource) throw new Error(`Unexpected AWS command: ${args[1]}`);
      return { stdout: JSON.stringify({ [String(args[1]).replace('get-', '')]: resource }) };
    } finally {
      if (concurrency) concurrency.active -= 1;
    }
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
