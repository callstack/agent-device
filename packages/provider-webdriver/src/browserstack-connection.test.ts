import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createBrowserStackConnection } from './browserstack-connection.ts';
import { verifyBrowserStackConnection } from './connection-verification.ts';
import type { CloudWebDriverProviderHost } from './provider-plugin.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

vi.mock('./connection-verification.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connection-verification.ts')>()),
  verifyBrowserStackConnection: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

const CREDENTIALS = { BROWSERSTACK_USERNAME: 'user', BROWSERSTACK_ACCESS_KEY: 'key' };
const FLAGS = {
  json: false,
  help: false,
  version: false,
  platform: 'android' as const,
  device: 'Google Pixel 8',
  providerOsVersion: '14.0',
  providerApp: 'bs://app-id',
};

function host(env: Record<string, string | undefined> = CREDENTIALS): CloudWebDriverProviderHost {
  return {
    env,
    clientVersion: '1.2.3',
    runHostCommand: async () => {
      throw new Error('BrowserStack runs no host commands');
    },
  };
}

test('connect resolves a profile carrying only the fields BrowserStack reads', async () => {
  const { profile, extraFlags } = createBrowserStackConnection(host()).resolve({
    flags: {
      ...FLAGS,
      providerApp: 'Bs://app-id',
      providerProject: 'agent-device',
      providerTimezone: 'Europe/Warsaw',
    },
    cwd: '/',
  });
  assert.deepEqual(profile, {
    leaseProvider: 'browserstack',
    platform: 'android',
    device: 'Google Pixel 8',
    providerOsVersion: '14.0',
    providerApp: 'bs://app-id',
    providerProject: 'agent-device',
    providerBuild: undefined,
    providerSessionName: undefined,
    providerTimezone: 'Europe/Warsaw',
  });
  assert.deepEqual(extraFlags, { providerApp: 'bs://app-id' });
});

test('connect refuses a malformed bs:// id, a missing local file, and AWS flags', async () => {
  const tempDir = mkdtempForTestSync('browserstack-connection-');
  const connection = createBrowserStackConnection(host());
  for (const app of ['bs://', 'bs://a b', 'BS://a/b']) {
    assert.throws(
      () => connection.resolve({ flags: { ...FLAGS, providerApp: app }, cwd: tempDir }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message === `BrowserStack --provider-app ${app} is not a bs:// app id.`,
    );
  }
  assert.throws(
    () => connection.resolve({ flags: { ...FLAGS, providerApp: './missing.apk' }, cwd: tempDir }),
    {
      code: 'INVALID_ARGS',
      message: `BrowserStack app file not found: ${path.join(tempDir, 'missing.apk')}`,
    },
  );
  assert.throws(
    () => connection.resolve({ flags: { ...FLAGS, awsRegion: 'us-west-2' }, cwd: tempDir }),
    (error: unknown) =>
      error instanceof AppError && JSON.stringify(error.details?.flags) === '["--aws-region"]',
  );
});

test('connect requires credentials, platform, device, OS version, and app', async () => {
  assert.throws(() => createBrowserStackConnection(host({})).resolve({ flags: FLAGS, cwd: '/' }), {
    message: 'connect browserstack requires BROWSERSTACK_USERNAME in the environment.',
  });
  const connection = createBrowserStackConnection(host());
  for (const [missing, flag] of [
    ['platform', '--platform ios|android'],
    ['device', '--device <name>'],
    ['providerOsVersion', '--provider-os-version <version>'],
    ['providerApp', '--provider-app <bs://app-id-or-local-path>'],
  ] as const) {
    assert.throws(
      () => connection.resolve({ flags: { ...FLAGS, [missing]: undefined }, cwd: '/' }),
      {
        code: 'INVALID_ARGS',
        message: `connect browserstack requires ${flag}.`,
      },
    );
  }
});

test('connect persists a local artifact as an absolute path and a public URL as is', async () => {
  const tempDir = mkdtempForTestSync('browserstack-connection-app-');
  fs.writeFileSync(path.join(tempDir, 'app.apk'), 'apk');
  const connection = createBrowserStackConnection(host());
  const local = connection.resolve({
    flags: { ...FLAGS, providerApp: './app.apk' },
    cwd: tempDir,
  });
  assert.equal(local.profile.providerApp, path.join(tempDir, 'app.apk'));
  const url = connection.resolve({
    flags: { ...FLAGS, providerApp: 'https://example.test/app.apk' },
    cwd: tempDir,
  });
  assert.equal(url.profile.providerApp, 'https://example.test/app.apk');
});

test('verify hands the saved profile and the client version to the verifier', async () => {
  const connection = createBrowserStackConnection(host());
  await connection.verify({ flags: FLAGS });
  assert.deepEqual(vi.mocked(verifyBrowserStackConnection).mock.calls[0], [
    {
      username: 'user',
      accessKey: 'key',
      platform: 'android',
      deviceName: 'Google Pixel 8',
      osVersion: '14.0',
      app: 'bs://app-id',
    },
    '1.2.3',
  ]);
  await assert.rejects(connection.verify({ flags: { ...FLAGS, device: undefined } }), {
    code: 'COMMAND_FAILED',
    message: 'BrowserStack profile missed device.',
  });
});
