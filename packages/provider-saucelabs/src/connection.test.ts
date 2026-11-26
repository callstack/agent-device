import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { ProviderPluginHost } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import { createSauceLabsConnection } from './connection.ts';
import { verifySauceLabsConnection } from './saucelabs-connection-verification.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

vi.mock('./saucelabs-connection-verification.ts', () => ({ verifySauceLabsConnection: vi.fn() }));

afterEach(() => vi.clearAllMocks());

const FILE_ID = '0b6a3f52-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const CREDENTIALS = { SAUCE_USERNAME: 'user', SAUCE_ACCESS_KEY: 'key' };
const FLAGS = {
  json: false,
  help: false,
  version: false,
  platform: 'android' as const,
  device: 'Google Pixel 8',
  providerOsVersion: '14',
  providerApp: `storage:${FILE_ID}`,
};

function host(env: Record<string, string | undefined> = CREDENTIALS): ProviderPluginHost {
  return {
    env,
    options: {},
    clientVersion: '1.2.3',
    createError: (code, message, details) => new AppError(code, message, details),
  };
}

test('connect resolves a profile with the canonical app reference and the session options', () => {
  const { profile, extraFlags } = createSauceLabsConnection(host()).resolve({
    flags: {
      ...FLAGS,
      providerApp: `STORAGE:${FILE_ID}`,
      providerBuild: 'build-7',
      providerDeviceOrientation: 'landscape',
    },
    cwd: '/',
  });
  assert.deepEqual(profile, {
    leaseProvider: 'saucelabs',
    platform: 'android',
    device: 'Google Pixel 8',
    providerOsVersion: '14',
    providerApp: `storage:${FILE_ID}`,
    providerBuild: 'build-7',
    providerSessionName: undefined,
    providerDeviceOrientation: 'landscape',
  });
  assert.deepEqual(extraFlags, { providerApp: `storage:${FILE_ID}` });
});

test('connect refuses flags Sauce Labs does not read, an unknown SAUCE_REGION, and Android no-resign', () => {
  const connection = createSauceLabsConnection(host());
  for (const [flags, expected] of [
    [{ providerProject: 'p' }, '["--provider-project"]'],
    [{ providerDeviceType: 'virtual' }, '["--provider-device-type"]'],
    [{ awsRegion: 'us-west-2' }, '["--aws-region"]'],
  ] as const) {
    assert.throws(
      () => connection.resolve({ flags: { ...FLAGS, ...flags }, cwd: '/' }),
      (error: unknown) =>
        error instanceof AppError && JSON.stringify(error.details?.flags) === expected,
    );
  }
  assert.throws(
    () =>
      createSauceLabsConnection(host({ ...CREDENTIALS, SAUCE_REGION: 'mars-1' })).resolve({
        flags: FLAGS,
        cwd: '/',
      }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'saucelabs_region_unknown',
  );
  assert.throws(
    () => connection.resolve({ flags: { ...FLAGS, providerNoResignApp: true }, cwd: '/' }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'saucelabs_no_resign_app_ios_only',
  );
});

test('connect requires credentials, platform, device, and app, but not an OS version', () => {
  assert.throws(() => createSauceLabsConnection(host({})).resolve({ flags: FLAGS, cwd: '/' }), {
    message: 'connect saucelabs requires SAUCE_USERNAME in the environment.',
  });
  const connection = createSauceLabsConnection(host());
  for (const [missing, flag] of [
    ['platform', '--platform ios|android'],
    ['device', '--device <name, id, or pattern>'],
    ['providerApp', '--provider-app <storage:file-id, https URL, or local path>'],
  ] as const) {
    assert.throws(
      () => connection.resolve({ flags: { ...FLAGS, [missing]: undefined }, cwd: '/' }),
      { code: 'INVALID_ARGS', message: `connect saucelabs requires ${flag}.` },
    );
  }
  const { profile } = connection.resolve({
    flags: { ...FLAGS, providerOsVersion: undefined },
    cwd: '/',
  });
  assert.equal(profile.providerOsVersion, undefined);
});

test('connect persists a local artifact as an absolute path and refuses a missing one or http', () => {
  const tempDir = mkdtempForTestSync('saucelabs-connection-app-');
  fs.writeFileSync(path.join(tempDir, 'app.ipa'), 'ipa');
  const connection = createSauceLabsConnection(host());
  const local = connection.resolve({
    flags: { ...FLAGS, platform: 'ios', providerApp: './app.ipa' },
    cwd: tempDir,
  });
  assert.equal(local.profile.providerApp, path.join(tempDir, 'app.ipa'));
  assert.throws(
    () => connection.resolve({ flags: { ...FLAGS, providerApp: './missing.apk' }, cwd: tempDir }),
    {
      code: 'INVALID_ARGS',
      message: `Sauce Labs app file not found: ${path.join(tempDir, 'missing.apk')}`,
    },
  );
  assert.throws(
    () =>
      connection.resolve({
        flags: { ...FLAGS, providerApp: 'http://example.test/app.apk' },
        cwd: tempDir,
      }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'saucelabs_app_url_insecure',
  );
});

test('verify hands the saved profile, the SAUCE_REGION data center, and the client version to the verifier', async () => {
  const connection = createSauceLabsConnection(host({ ...CREDENTIALS, SAUCE_REGION: 'us-east-4' }));
  await connection.verify({ flags: FLAGS });
  assert.deepEqual(vi.mocked(verifySauceLabsConnection).mock.calls[0], [
    {
      username: 'user',
      accessKey: 'key',
      region: 'us-east-4',
      platform: 'android',
      deviceName: 'Google Pixel 8',
      osVersion: '14',
      app: `storage:${FILE_ID}`,
    },
    '1.2.3',
  ]);
  await assert.rejects(connection.verify({ flags: { ...FLAGS, device: undefined } }), {
    code: 'COMMAND_FAILED',
    message: 'Sauce Labs profile missed device.',
  });
});
