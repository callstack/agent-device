import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { ProviderPluginHost } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import { createBrowserStackConnection } from './connection.ts';
import { verifyBrowserStackConnection } from './browserstack-connection-verification.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

vi.mock('./browserstack-connection-verification.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./browserstack-connection-verification.ts')>()),
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

function host(env: Record<string, string | undefined> = CREDENTIALS): ProviderPluginHost {
  return {
    env,
    options: {},
    clientVersion: '1.2.3',
    runHostCommand: async () => {
      throw new Error('host command unused');
    },
    diagnostics: { emit: () => {} },
    createError: (code, message, details) => new AppError(code, message, details),
  };
}

const CONTEXT = { stateDir: '/state', env: CREDENTIALS, host: host() };

test('connect resolves a profile carrying only the fields BrowserStack reads', async () => {
  const { profile, extraFlags } = await createBrowserStackConnection(host()).resolve({
    flags: {
      ...FLAGS,
      providerApp: 'Bs://app-id',
      providerProject: 'agent-device',
      providerTimezone: 'Europe/Warsaw',
    },
    ...CONTEXT,
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
    await assert.rejects(
      async () =>
        connection.resolve({ flags: { ...FLAGS, providerApp: app }, ...CONTEXT, cwd: tempDir }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message === `BrowserStack --provider-app ${app} is not a bs:// app id.`,
    );
  }
  await assert.rejects(
    async () =>
      connection.resolve({
        flags: { ...FLAGS, providerApp: './missing.apk' },
        ...CONTEXT,
        cwd: tempDir,
      }),
    {
      code: 'INVALID_ARGS',
      message: `BrowserStack app file not found: ${path.join(tempDir, 'missing.apk')}`,
    },
  );
  await assert.rejects(
    async () =>
      connection.resolve({ flags: { ...FLAGS, awsRegion: 'us-west-2' }, ...CONTEXT, cwd: tempDir }),
    (error: unknown) =>
      error instanceof AppError && JSON.stringify(error.details?.flags) === '["--aws-region"]',
  );
});

test('connect requires credentials, platform, device, OS version, and app', async () => {
  await assert.rejects(
    async () =>
      createBrowserStackConnection(host({})).resolve({ flags: FLAGS, ...CONTEXT, cwd: '/' }),
    {
      message: 'connect browserstack requires BROWSERSTACK_USERNAME in the environment.',
    },
  );
  const connection = createBrowserStackConnection(host());
  for (const [missing, flag] of [
    ['platform', '--platform ios|android'],
    ['device', '--device <name>'],
    ['providerOsVersion', '--provider-os-version <version>'],
    ['providerApp', '--provider-app <bs://app-id-or-local-path>'],
  ] as const) {
    await assert.rejects(
      async () =>
        connection.resolve({ flags: { ...FLAGS, [missing]: undefined }, ...CONTEXT, cwd: '/' }),
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
  const local = await connection.resolve({
    flags: { ...FLAGS, providerApp: './app.apk' },
    ...CONTEXT,
    cwd: tempDir,
  });
  assert.equal(local.profile.providerApp, path.join(tempDir, 'app.apk'));
  const url = await connection.resolve({
    flags: { ...FLAGS, providerApp: 'https://example.test/app.apk' },
    ...CONTEXT,
    cwd: tempDir,
  });
  assert.equal(url.profile.providerApp, 'https://example.test/app.apk');
});

test('verify hands the saved profile and the client version to the verifier', async () => {
  const connection = createBrowserStackConnection(host());
  await connection.verify({ flags: FLAGS, env: CREDENTIALS, host: host() });
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
  await assert.rejects(
    connection.verify({ flags: { ...FLAGS, device: undefined }, env: CREDENTIALS, host: host() }),
    {
      code: 'COMMAND_FAILED',
      message: 'BrowserStack profile missed device.',
    },
  );
});
