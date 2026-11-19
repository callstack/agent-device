import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { ProviderPluginHost } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import browserstack from './index.ts';
import type { AgentDevicePlugin } from 'agent-device/plugins';

function providerOf<P extends AgentDevicePlugin>(plugin: P) {
  const [contribution] = plugin.contributes;
  if (contribution.kind !== 'provider') throw new Error('expected a provider contribution');
  return contribution as Extract<P['contributes'][number], { kind: 'provider' }>;
}

import { verifyBrowserStackConnection } from './browserstack-connection-verification.ts';

vi.mock('./browserstack-connection-verification.ts', () => ({
  verifyBrowserStackConnection: vi.fn(),
}));

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function host(env: Record<string, string | undefined>): ProviderPluginHost {
  return {
    env,
    options: {},
    clientVersion: '0.0.0-test',
    runHostCommand: async () => {
      throw new Error('host command unused');
    },
    createError: (code, message, details) => new AppError(code, message, details),
  };
}

function capturedAuthorization(): { read(): string | undefined } {
  let authorization: string | undefined;
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? undefined;
    return new Response(JSON.stringify({}));
  };
  return { read: () => authorization };
}

async function listArtifacts(
  provider: Extract<AgentDevicePlugin['contributes'][number], { kind: 'provider' }>,
  env: Record<string, string>,
) {
  const setup = await provider.setup(host(env));
  if (!('webDriver' in setup)) throw new Error('BrowserStack sets up a WebDriver descriptor');
  await setup.webDriver.listArtifacts!({ provider: 'browserstack', providerSessionId: 'SESSION1' });
}

const basic = (username: string, accessKey: string) =>
  `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;

test('the plugin declares its provider, capabilities and credential variables', () => {
  const plugin = browserstack();
  assert.equal(plugin.apiVersion, 3);
  assert.equal(providerOf(plugin).provider, 'browserstack');
  assert.deepEqual(providerOf(plugin).credentials, {
    variables: ['BROWSERSTACK_USERNAME', 'BROWSERSTACK_ACCESS_KEY'],
  });
  assert.deepEqual(providerOf(plugin).connection?.capabilities, {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: false,
    requiresRemoteDaemon: false,
    supportsArtifacts: true,
    supportsDeferredAppSelection: false,
    supportsDirectPortReverse: false,
    usesCloudWebDriverLease: true,
  });
});

test('setup builds a WebDriver descriptor that reads its hub endpoint from the environment', async () => {
  const setup = await providerOf(browserstack()).setup(
    host({
      BROWSERSTACK_USERNAME: 'user',
      BROWSERSTACK_ACCESS_KEY: 'key',
      BROWSERSTACK_WEBDRIVER_ENDPOINT: 'https://hub.test/wd/hub/',
    }),
  );
  if (!('webDriver' in setup)) throw new Error('BrowserStack sets up a WebDriver descriptor');
  assert.equal(setup.webDriver.provider, 'browserstack');
  assert.equal(setup.webDriver.endpoint, 'https://hub.test/wd/hub/');
  assert.equal(setup.webDriver.profileFields.provider, 'browserstack');
});

test('the plugin declares the BrowserStack variables only when it reads credentials from the environment', () => {
  assert.deepEqual(providerOf(browserstack()).credentials, {
    variables: ['BROWSERSTACK_USERNAME', 'BROWSERSTACK_ACCESS_KEY'],
  });
  assert.deepEqual(providerOf(browserstack({ credentials: { username: 'u', accessKey: 'k' } })).credentials, {
    variables: [],
  });
});

test('a credentials object missing one key still declares the variable it reads from the environment', () => {
  assert.deepEqual(providerOf(browserstack({ credentials: { username: 'u' } })).credentials, {
    variables: ['BROWSERSTACK_ACCESS_KEY'],
  });
  assert.deepEqual(providerOf(browserstack({ credentials: { accessKey: 'k' } })).credentials, {
    variables: ['BROWSERSTACK_USERNAME'],
  });
});

test('credentials passed as options replace the environment, which stays the fallback', async () => {
  const captured = capturedAuthorization();
  const env = { BROWSERSTACK_USERNAME: 'env-user', BROWSERSTACK_ACCESS_KEY: 'env-key' };

  await listArtifacts(
    providerOf(browserstack({ credentials: { username: 'opt-user', accessKey: 'opt-key' } })),
    env,
  );
  assert.equal(captured.read(), basic('opt-user', 'opt-key'));
  await listArtifacts(
    providerOf(browserstack({ credentials: { username: 'opt-user', accessKey: 'opt-key' } })),
    {},
  );
  assert.equal(captured.read(), basic('opt-user', 'opt-key'));
  await listArtifacts(providerOf(browserstack()), env);
  assert.equal(captured.read(), basic('env-user', 'env-key'));
  await assert.rejects(listArtifacts(providerOf(browserstack()), {}), { code: 'INVALID_ARGS' });
});

test('a credentials object missing one key falls back to the environment for that key', async () => {
  const captured = capturedAuthorization();
  await listArtifacts(providerOf(browserstack({ credentials: { username: 'opt-user' } })), {
    BROWSERSTACK_USERNAME: 'env-user',
    BROWSERSTACK_ACCESS_KEY: 'env-key',
  });
  assert.equal(captured.read(), basic('opt-user', 'env-key'));
  await listArtifacts(providerOf(browserstack({ credentials: { accessKey: 'opt-key' } })), {
    BROWSERSTACK_USERNAME: 'env-user',
    BROWSERSTACK_ACCESS_KEY: 'env-key',
  });
  assert.equal(captured.read(), basic('env-user', 'opt-key'));
});

test.each([
  [{ username: '' }, ['BROWSERSTACK_ACCESS_KEY']],
  [{ accessKey: '' }, ['BROWSERSTACK_USERNAME']],
] as const)(
  'explicit empty credential %j never falls back to the environment',
  async (credentials, variables) => {
    const env = { BROWSERSTACK_USERNAME: 'env-user', BROWSERSTACK_ACCESS_KEY: 'env-key' };
    const fetch = vi.fn(async () => new Response('{}'));
    globalThis.fetch = fetch;
    const flags = {
      json: false,
      help: false,
      version: false,
      platform: 'android',
      device: 'Pixel',
      providerOsVersion: '14',
      providerApp: 'bs://app-id',
    } as const;
    const plugin = browserstack({ credentials });
    const [resolve, artifacts] = await Promise.allSettled([
      Promise.resolve().then(() =>
        providerOf(plugin).connection!.resolve({ flags, stateDir: '/state', cwd: '/', env, host: host(env) }),
      ),
      listArtifacts(providerOf(plugin), env),
    ]);
    assert.equal(resolve.status, 'rejected');
    if (resolve.status === 'rejected') assert.equal(resolve.reason.code, 'INVALID_ARGS');
    assert.equal(artifacts.status, 'rejected');
    if (artifacts.status === 'rejected') assert.equal(artifacts.reason.code, 'INVALID_ARGS');
    assert.deepEqual(providerOf(plugin).credentials, { variables });
    assert.equal(fetch.mock.calls.length, 0);
  },
);

test('connect uses the option credentials without an environment and verifies with them', async () => {
  vi.mocked(verifyBrowserStackConnection).mockResolvedValue({
    provider: 'browserstack',
    service: 'BrowserStack',
    verificationMessage: 'verified',
    device: { status: 'verified', name: 'Google Pixel 8', platform: 'android', osVersion: '14.0' },
    app: { status: 'verified', reference: 'bs://app-id' },
  });
  const { connection } = providerOf(
    browserstack({
      credentials: { username: 'opt-user', accessKey: 'opt-key' },
    }),
  );
  const flags = {
    json: false,
    help: false,
    version: false,
    platform: 'android',
    device: 'Google Pixel 8',
    providerOsVersion: '14.0',
    providerApp: 'bs://app-id',
  } as const;

  const resolved = await connection!.resolve({
    flags,
    stateDir: '/state',
    cwd: '/work',
    env: {},
    host: host({}),
  });
  assert.equal(resolved.profile.leaseProvider, 'browserstack');
  await connection!.verify({ flags, env: {}, host: host({}) });
  assert.deepEqual(
    [
      vi.mocked(verifyBrowserStackConnection).mock.calls[0]?.[0].username,
      vi.mocked(verifyBrowserStackConnection).mock.calls[0]?.[0].accessKey,
    ],
    ['opt-user', 'opt-key'],
  );
  await assert.rejects(
    async () =>
      await providerOf(browserstack()).connection!.resolve({
        flags,
        stateDir: '/state',
        cwd: '/work',
        env: {},
        host: host({}),
      }),
    { code: 'INVALID_ARGS' },
  );
});
