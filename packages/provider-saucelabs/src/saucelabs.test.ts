import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { SAUCE_LABS_PROFILE_FIELDS } from './profile-fields.ts';
import {
  buildSauceLabsCapabilities,
  describeSauceLabsSession,
  listSauceLabsCloudArtifacts,
  readSauceLabsSessionFields,
  resolveSauceLabsAppReference,
  SAUCE_LABS_SESSION_CREATION_TIMEOUT_MS,
} from './saucelabs.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import createSession from './fixtures/create-session-android.json' with { type: 'json' };
import jobRunning from './fixtures/job-running.json' with { type: 'json' };
import jobEnded from './fixtures/job-ended.json' with { type: 'json' };

const FILE_ID = '0b6a3f52-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const JOB_ID = '0123456789abcdef0123456789abcdef';
const API = {
  clientVersion: '1.2.3',
  username: 'sauce-user',
  accessKey: 'sauce-key',
  region: 'eu-central-1' as const,
};

afterEach(() => vi.unstubAllGlobals());

function stubJob(body: unknown, status = 200) {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

test('capabilities put Appium keys at the top level and Sauce options in sauce:options', () => {
  const capabilities = buildSauceLabsCapabilities({
    platform: 'ios',
    deviceName: 'iPhone 15',
    osVersion: '17',
    app: `storage:${FILE_ID}`,
    buildName: 'run-1',
    sessionName: 'lease-1',
    providerDeviceOrientation: 'landscape',
    providerNoResignApp: true,
    base: { platformName: 'iOS', 'appium:deviceName': 'base device' },
  });
  assert.deepEqual(capabilities, {
    platformName: 'iOS',
    'appium:deviceName': 'iPhone 15',
    'appium:platformVersion': '17',
    'appium:automationName': 'XCUITest',
    'appium:app': `storage:${FILE_ID}`,
    'appium:newCommandTimeout': 90,
    'appium:orientation': 'LANDSCAPE',
    'sauce:options': {
      name: 'lease-1',
      build: 'run-1',
      appiumVersion: 'latest',
      sessionCreationTimeout: SAUCE_LABS_SESSION_CREATION_TIMEOUT_MS,
      sessionCreationRetry: 0,
      resigningEnabled: false,
    },
  });
  const android = buildSauceLabsCapabilities({
    platform: 'android',
    deviceName: 'Google Pixel 8',
    app: `storage:${FILE_ID}`,
    buildName: 'run-1',
    sessionName: 'lease-1',
    providerAppiumVersion: 'stable',
    base: { platformName: 'Android' },
  });
  assert.equal(android['appium:automationName'], 'UiAutomator2');
  assert.equal('appium:platformVersion' in android, false);
  assert.equal((android['sauce:options'] as Record<string, unknown>).appiumVersion, 'stable');
});

// The client waits 180 s for the whole create, app install included.
test('Sauce Labs stops looking for a device well inside the client create budget, without retrying', () => {
  assert.ok(SAUCE_LABS_SESSION_CREATION_TIMEOUT_MS >= 60_000);
  assert.ok(SAUCE_LABS_SESSION_CREATION_TIMEOUT_MS <= 120_000);
});

test('session fields validate the orientation and refuse --provider-no-resign-app on Android', () => {
  assert.deepEqual(
    readSauceLabsSessionFields(
      {
        providerDeviceOrientation: 'portrait',
        providerAppiumVersion: '',
        providerNoResignApp: true,
      },
      'ios',
    ),
    { providerDeviceOrientation: 'portrait', providerNoResignApp: true },
  );
  assert.throws(
    () => readSauceLabsSessionFields({ providerDeviceOrientation: 'upside-down' }, 'android'),
    { code: 'INVALID_ARGS' },
  );
  assert.throws(
    () => readSauceLabsSessionFields({ providerNoResignApp: true }, 'android'),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'saucelabs_no_resign_app_ios_only',
  );
});

// A consumed field the session never reads would be accepted and then dropped.
test('Sauce Labs consumes exactly the fields its session reads', () => {
  const consumed = Object.entries(SAUCE_LABS_PROFILE_FIELDS.fields)
    .filter(([, use]) => use === 'consumed')
    .map(([field]) => field)
    .sort();
  assert.deepEqual(consumed, [
    'providerApp',
    'providerAppiumVersion',
    'providerBuild',
    'providerDeviceOrientation',
    'providerNoResignApp',
    'providerOsVersion',
    'providerSessionName',
  ]);
});

test('a live create-session answer names the job id and the device the hub allocated', () => {
  assert.deepEqual(describeSauceLabsSession(createSession.value.capabilities), {
    providerSessionId: JOB_ID,
    model: 'Google Pixel 8 (Google_Pixel_8_15_real)',
  });
});

test('the job id falls back to the report URLs, trailing slash or not, and is absent otherwise', () => {
  for (const capabilities of [
    { testobject_test_report_api_url: `https://api.test/v1/rdc/jobs/${JOB_ID}/` },
    { testobject_test_report_url: `https://app.test/tests/${JOB_ID}?tab=video` },
    { 'appium:jobUuid': JOB_ID },
  ]) {
    assert.equal(describeSauceLabsSession(capabilities).providerSessionId, JOB_ID);
  }
  assert.deepEqual(describeSauceLabsSession({ jobUuid: 'not-a-job' }), {
    providerSessionId: undefined,
  });
});

test('a running job lists its dashboard link at once and leaves media pending', async () => {
  const fetchMock = stubJob(jobRunning);
  const running = await listSauceLabsCloudArtifacts('saucelabs', JOB_ID, API);
  assert.equal(running?.status, 'pending');
  assert.deepEqual(
    running?.cloudArtifacts.map(({ kind, url }) => [kind, url]),
    [['provider-session', `https://app.eu-central-1.saucelabs.com/tests/${JOB_ID}`]],
  );
  assert.equal(
    String(fetchMock.mock.calls[0]?.[0]),
    `https://api.eu-central-1.saucelabs.com/v1/rdc/jobs/${JOB_ID}`,
  );
  assert.equal(
    new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization'),
    `Basic ${Buffer.from('sauce-user:sauce-key').toString('base64')}`,
  );
});

test('an ended job lists its media and logs beside the dashboard link', async () => {
  stubJob(jobEnded);
  const ended = await listSauceLabsCloudArtifacts('saucelabs', JOB_ID, {
    ...API,
    region: 'us-west-1',
  });
  assert.equal(ended?.status, 'ready');
  assert.deepEqual(
    ended?.cloudArtifacts.map(({ kind, name }) => [kind, name]),
    [
      ['video', 'Session video'],
      ['appium-log', 'Appium logs'],
      ['device-log', 'Device logs'],
      ['automation-log', 'WebDriver requests'],
      ['provider-session', 'Sauce Labs dashboard'],
    ],
  );
  assert.equal(ended?.cloudArtifacts.at(-1)?.url, `https://app.saucelabs.com/tests/${JOB_ID}`);
});

test('rejected credentials and an unknown job fail typed, never as pending', async () => {
  stubJob({ detail: 'Authorization failed' }, 401);
  await assert.rejects(listSauceLabsCloudArtifacts('saucelabs', JOB_ID, API), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'UNAUTHORIZED');
    assert.doesNotMatch(JSON.stringify(error), /sauce-key/);
    return true;
  });
  stubJob({ code: 'JOB_NOT_FOUND' }, 404);
  await assert.rejects(
    listSauceLabsCloudArtifacts('saucelabs', JOB_ID, API),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'saucelabs_job_not_found',
  );
});

test('a session without a job id answers unavailable instead of looking up another id', async () => {
  const fetchMock = stubJob(jobEnded);
  const result = await listSauceLabsCloudArtifacts(
    'saucelabs',
    '11111111-2222-4333-8444-555555555555',
    API,
  );
  assert.equal(result?.status, 'unavailable');
  assert.deepEqual(result?.cloudArtifacts, []);
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.equal(await listSauceLabsCloudArtifacts('saucelabs', undefined, API), undefined);
});

test('a local app is uploaded with its file name and referenced by file id', async () => {
  const dir = mkdtempForTestSync('saucelabs-upload-');
  fs.writeFileSync(path.join(dir, 'app-release.apk'), 'apk');
  const fetchMock = stubJob({ item: { id: FILE_ID, name: 'app-release.apk' } });

  assert.equal(
    await resolveSauceLabsAppReference('app-release.apk', { ...API, cwd: dir }),
    `storage:${FILE_ID}`,
  );
  const [input, init] = fetchMock.mock.calls[0] ?? [];
  assert.equal(String(input), 'https://api.eu-central-1.saucelabs.com/v1/storage/upload');
  const form = init?.body;
  assert.ok(form instanceof FormData);
  assert.ok(form.get('payload') instanceof Blob);
  assert.equal(form.get('name'), 'app-release.apk');

  fetchMock.mockClear();
  assert.equal(await resolveSauceLabsAppReference(`storage:${FILE_ID}`, API), `storage:${FILE_ID}`);
  assert.equal(
    await resolveSauceLabsAppReference('https://example.test/app.apk', API),
    'https://example.test/app.apk',
  );
  assert.equal(fetchMock.mock.calls.length, 0);
  await assert.rejects(
    resolveSauceLabsAppReference('http://example.test/app.apk', API),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'saucelabs_app_url_insecure',
  );
});
