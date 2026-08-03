import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createProviderWebDriver } from './index.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('BrowserStack verification checks credentials, the exact device, and an uploaded app without creating a session', async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { os: 'android', os_version: '14.0', device: 'Google Pixel 8', realMobile: true },
        ]),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            app_name: 'sample.apk',
            app_version: '1.2.3',
            app_url: 'bs://app-id',
          },
        ]),
        { status: 200 },
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  const provider = createProviderWebDriver({
    clientVersion: '1.2.3',
    runHostCommand: vi.fn(),
  });

  const result = await provider.verifyConnection({
    provider: 'browserstack',
    username: 'browser-user',
    accessKey: 'browser-key',
    platform: 'android',
    deviceName: 'Google Pixel 8',
    osVersion: '14.0',
    app: 'bs://app-id',
  });

  assert.deepEqual(result, {
    provider: 'browserstack',
    service: 'BrowserStack',
    verificationMessage: 'Credentials, device, and uploaded app verified.',
    device: {
      status: 'verified',
      name: 'Google Pixel 8',
      platform: 'android',
      osVersion: '14.0',
    },
    app: {
      status: 'verified',
      name: 'sample.apk',
      reference: 'bs://app-id',
      version: '1.2.3',
    },
  });
  assert.deepEqual(
    fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      method: init?.method ?? 'GET',
    })),
    [
      {
        url: 'https://api-cloud.browserstack.com/app-automate/devices.json',
        method: 'GET',
      },
      {
        url: 'https://api-cloud.browserstack.com/app-automate/recent_apps?limit=100',
        method: 'GET',
      },
    ],
  );
});

test('BrowserStack verification classifies rejected credentials without exposing them', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 401 })),
  );
  const provider = createProviderWebDriver({
    clientVersion: '1.2.3',
    runHostCommand: vi.fn(),
  });

  await assert.rejects(
    provider.verifyConnection({
      provider: 'browserstack',
      username: 'browser-user',
      accessKey: 'browser-key',
      platform: 'android',
      deviceName: 'Google Pixel 8',
      osVersion: '14.0',
      app: 'bs://app-id',
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
      assert.doesNotMatch(JSON.stringify(error), /browser-key/);
      return true;
    },
  );
});

test('AWS Device Farm verification reads the exact resources and never creates a remote access session', async () => {
  const runHostCommand = vi.fn(async (_command: string, args: readonly string[]) => {
    const subcommand = args[1];
    if (subcommand === 'get-project') {
      return {
        stdout: JSON.stringify({
          project: { arn: 'project-arn', name: 'Agent Device' },
        }),
      };
    }
    if (subcommand === 'get-device') {
      return {
        stdout: JSON.stringify({
          device: {
            arn: 'device-arn',
            name: 'Google Pixel 8',
            platform: 'ANDROID',
            os: '14',
            availability: 'HIGHLY_AVAILABLE',
          },
        }),
      };
    }
    if (subcommand === 'get-upload') {
      return {
        stdout: JSON.stringify({
          upload: {
            arn: 'app-arn',
            name: 'sample.apk',
            type: 'ANDROID_APP',
            status: 'SUCCEEDED',
          },
        }),
      };
    }
    throw new Error(`Unexpected AWS command: ${subcommand}`);
  });
  const provider = createProviderWebDriver({ clientVersion: '1.2.3', runHostCommand });

  const result = await provider.verifyConnection({
    provider: 'aws-device-farm',
    platform: 'android',
    projectArn: 'project-arn',
    deviceArn: 'device-arn',
    appArn: 'app-arn',
    region: 'us-west-2',
  });

  assert.deepEqual(result, {
    provider: 'aws-device-farm',
    service: 'AWS Device Farm',
    verificationMessage: 'Credentials, project, device, and app upload verified.',
    project: { name: 'Agent Device', reference: 'project-arn' },
    device: {
      status: 'verified',
      name: 'Google Pixel 8',
      reference: 'device-arn',
      platform: 'android',
      osVersion: '14',
      availability: 'HIGHLY_AVAILABLE',
    },
    app: {
      status: 'verified',
      name: 'sample.apk',
      reference: 'app-arn',
    },
  });
  assert.deepEqual(
    runHostCommand.mock.calls.map(([, args]) => args.slice(0, 2)),
    [
      ['devicefarm', 'get-project'],
      ['devicefarm', 'get-device'],
      ['devicefarm', 'get-upload'],
    ],
  );
  assert.equal(
    runHostCommand.mock.calls.some(([, args]) => args.includes('create-remote-access-session')),
    false,
  );
});

test('AWS Device Farm reports an unattached app without pretending it is installed', async () => {
  const runHostCommand = vi.fn(async (_command: string, args: readonly string[]) => ({
    stdout:
      args[1] === 'get-project'
        ? JSON.stringify({ project: { arn: 'project-arn', name: 'Agent Device' } })
        : JSON.stringify({
            device: {
              arn: 'device-arn',
              name: 'iPhone 15',
              platform: 'IOS',
              os: '17',
            },
          }),
  }));
  const provider = createProviderWebDriver({ clientVersion: '1.2.3', runHostCommand });

  const result = await provider.verifyConnection({
    provider: 'aws-device-farm',
    platform: 'ios',
    projectArn: 'project-arn',
    deviceArn: 'device-arn',
    region: 'us-west-2',
  });

  assert.equal(result.app.status, 'missing');
  assert.match(result.app.message ?? '', /--aws-app-arn/);
  assert.equal(runHostCommand.mock.calls.length, 2);
});

test('AWS Device Farm rejects a device from the wrong platform before allocation', async () => {
  const runHostCommand = vi.fn(async (_command: string, args: readonly string[]) => ({
    stdout:
      args[1] === 'get-project'
        ? JSON.stringify({ project: { arn: 'project-arn', name: 'Agent Device' } })
        : JSON.stringify({
            device: { arn: 'device-arn', name: 'iPhone 15', platform: 'IOS', os: '17' },
          }),
  }));
  const provider = createProviderWebDriver({ clientVersion: '1.2.3', runHostCommand });

  await assert.rejects(
    provider.verifyConnection({
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
