import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { ProviderPluginHost } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import testmu from './index.ts';
import { verifyTestMuConnection } from './testmu-connection-verification.ts';
import manifest from '../package.json' with { type: 'json' };

vi.mock('./testmu-connection-verification.ts', () => ({ verifyTestMuConnection: vi.fn() }));

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
    createError: (code, message, details) => new AppError(code, message, details),
  };
}

function capturedAuthorization(): { read(): string | undefined } {
  let authorization: string | undefined;
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? undefined;
    return new Response(JSON.stringify({ data: {} }));
  };
  return { read: () => authorization };
}

async function listArtifacts(plugin: ReturnType<typeof testmu>, env: Record<string, string>) {
  const setup = await plugin.setup(host(env));
  if (!('webDriver' in setup)) throw new Error('TestMu AI sets up a WebDriver descriptor');
  await setup.webDriver.listArtifacts!({ provider: 'testmu', providerSessionId: 'SESSION1' });
}

const basic = (username: string, accessKey: string) =>
  `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;

test('the plugin declares the LT variables only when it reads credentials from the environment', () => {
  assert.deepEqual(testmu().credentials, { variables: ['LT_USERNAME', 'LT_ACCESS_KEY'] });
  assert.deepEqual(testmu({ credentials: { username: 'u', accessKey: 'k' } }).credentials, {
    variables: [],
  });
});

test('credentials passed as options replace the environment, which stays the fallback', async () => {
  const captured = capturedAuthorization();
  const env = { LT_USERNAME: 'env-user', LT_ACCESS_KEY: 'env-key' };

  await listArtifacts(testmu({ credentials: { username: 'opt-user', accessKey: 'opt-key' } }), env);
  assert.equal(captured.read(), basic('opt-user', 'opt-key'));
  await listArtifacts(testmu({ credentials: { username: 'opt-user', accessKey: 'opt-key' } }), {});
  assert.equal(captured.read(), basic('opt-user', 'opt-key'));
  await listArtifacts(testmu(), env);
  assert.equal(captured.read(), basic('env-user', 'env-key'));
  await assert.rejects(listArtifacts(testmu(), {}), { code: 'INVALID_ARGS' });
});

test('connect uses the option credentials without an environment and verifies with them', async () => {
  vi.mocked(verifyTestMuConnection).mockResolvedValue({
    provider: 'testmu',
    service: 'TestMu AI',
    verificationMessage: 'verified',
    device: { status: 'verified', name: 'iPhone 16', platform: 'ios', osVersion: '18.0' },
    app: { status: 'verified', reference: 'lt://APP1' },
  });
  const { connection } = testmu({ credentials: { username: 'opt-user', accessKey: 'opt-key' } });
  const flags = {
    json: false,
    help: false,
    version: false,
    platform: 'ios',
    device: 'iPhone 16',
    providerOsVersion: '18.0',
    providerApp: 'lt://APP1',
  } as const;

  const resolved = await connection!.resolve({
    flags,
    stateDir: '/state',
    cwd: '/work',
    env: {},
    host: host({}),
  });
  assert.equal(resolved.profile.leaseProvider, 'testmu');
  await connection!.verify({ flags, env: {}, host: host({}) });
  assert.deepEqual(
    [
      vi.mocked(verifyTestMuConnection).mock.calls[0]?.[0].username,
      vi.mocked(verifyTestMuConnection).mock.calls[0]?.[0].accessKey,
    ],
    ['opt-user', 'opt-key'],
  );
  assert.throws(
    () =>
      testmu().connection!.resolve({
        flags,
        stateDir: '/state',
        cwd: '/work',
        env: {},
        host: host({}),
      }),
    { code: 'INVALID_ARGS' },
  );
});

test('the v2 declaration matches the v1 manifest that hosts without the v2 contract read', () => {
  const v1 = manifest.agentDevicePlugin;
  assert.equal(testmu().provider, v1.provider);
  assert.deepEqual(testmu().connection?.capabilities, v1.connection);
  assert.deepEqual(testmu().credentials.variables, v1.credentialVariables);
  assert.equal(v1.apiVersion, 1);
});

test('a credentials object missing one key falls back to the environment for that key', async () => {
  const captured = capturedAuthorization();
  await listArtifacts(testmu({ credentials: { username: 'opt-user' } as never }), {
    LT_USERNAME: 'env-user',
    LT_ACCESS_KEY: 'env-key',
  });
  assert.equal(captured.read(), basic('opt-user', 'env-key'));
});
