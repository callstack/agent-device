import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { ProviderPluginHost, AgentDevicePlugin } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import testmu from './index.ts';

function providerOf<P extends AgentDevicePlugin>(plugin: P) {
  const [contribution] = plugin.contributes;
  if (contribution.kind !== 'provider') throw new Error('expected a provider contribution');
  return contribution as Extract<P['contributes'][number], { kind: 'provider' }>;
}

import { verifyTestMuConnection } from './testmu-connection-verification.ts';

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
    runHostCommand: async () => {
      throw new Error('host command unused');
    },
    diagnostics: { emit: () => {} },
    createError: (code, message, details) => new AppError(code, message, details),
  };
}

function capturedAuthorization(): { read(): string | undefined } {
  let authorization: string | undefined;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') {
      authorization = new Headers(init.headers).get('authorization') ?? undefined;
      return Response.json({ value: { sessionId: 'SESSION1', capabilities: {} } });
    }
    return Response.json({ value: null });
  };
  return { read: () => authorization };
}

async function allocate(
  provider: Extract<AgentDevicePlugin['contributes'][number], { kind: 'provider' }>,
  env: Record<string, string>,
) {
  const { runtime } = await provider.setup(host(env));
  try {
    const allocation = await (runtime as ProviderDeviceRuntime).leaseLifecycle.allocate!(
      {
        leaseId: 'lease-1',
        tenantId: 'tenant',
        runId: 'run',
        backend: 'android-instance',
        leaseProvider: 'testmu',
        createdAt: 1,
        heartbeatAt: 1,
        expiresAt: 2,
      },
      {
        flags: {
          platform: 'android',
          device: 'Pixel 8',
          providerOsVersion: '14',
          providerApp: 'lt://APP1',
        },
      },
    );
    assert.equal(allocation?.providerSessionId, 'SESSION1');
  } finally {
    await runtime.shutdown();
  }
}

const basic = (username: string, accessKey: string) =>
  `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;

test('the plugin declares the LT variables only when it reads credentials from the environment', () => {
  assert.deepEqual(providerOf(testmu()).credentials, {
    variables: ['LT_USERNAME', 'LT_ACCESS_KEY'],
  });
  assert.deepEqual(
    providerOf(testmu({ credentials: { username: 'u', accessKey: 'k' } })).credentials,
    {
      variables: [],
    },
  );
});

test('a credentials object missing one key still declares the variable it reads from the environment', () => {
  assert.deepEqual(providerOf(testmu({ credentials: { username: 'u' } as never })).credentials, {
    variables: ['LT_ACCESS_KEY'],
  });
  assert.deepEqual(providerOf(testmu({ credentials: { accessKey: 'k' } as never })).credentials, {
    variables: ['LT_USERNAME'],
  });
});

test('credentials passed as options replace the environment, which stays the fallback', async () => {
  const captured = capturedAuthorization();
  const env = { LT_USERNAME: 'env-user', LT_ACCESS_KEY: 'env-key' };

  await allocate(
    providerOf(testmu({ credentials: { username: 'opt-user', accessKey: 'opt-key' } })),
    env,
  );
  assert.equal(captured.read(), basic('opt-user', 'opt-key'));
  await allocate(
    providerOf(testmu({ credentials: { username: 'opt-user', accessKey: 'opt-key' } })),
    {},
  );
  assert.equal(captured.read(), basic('opt-user', 'opt-key'));
  await allocate(providerOf(testmu()), env);
  assert.equal(captured.read(), basic('env-user', 'env-key'));
  await assert.rejects(allocate(providerOf(testmu()), {}), { code: 'INVALID_ARGS' });
});

test('connect uses the option credentials without an environment and verifies with them', async () => {
  vi.mocked(verifyTestMuConnection).mockResolvedValue({
    provider: 'testmu',
    service: 'TestMu AI',
    verificationMessage: 'verified',
    device: { status: 'verified', name: 'iPhone 16', platform: 'ios', osVersion: '18.0' },
    app: { status: 'verified', reference: 'lt://APP1' },
  });
  const { connection } = providerOf(
    testmu({ credentials: { username: 'opt-user', accessKey: 'opt-key' } }),
  );
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
  await assert.rejects(
    async () =>
      await providerOf(testmu()).connection!.resolve({
        flags,
        stateDir: '/state',
        cwd: '/work',
        env: {},
        host: host({}),
      }),
    { code: 'INVALID_ARGS' },
  );
});

test('the plugin declares its provider, capabilities and credential variables', () => {
  const plugin = testmu();
  assert.equal(plugin.apiVersion, 3);
  assert.equal(providerOf(plugin).provider, 'testmu');
  assert.deepEqual(providerOf(plugin).credentials, { variables: ['LT_USERNAME', 'LT_ACCESS_KEY'] });
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

test('a credentials object missing one key falls back to the environment for that key', async () => {
  const captured = capturedAuthorization();
  await allocate(providerOf(testmu({ credentials: { username: 'opt-user' } as never })), {
    LT_USERNAME: 'env-user',
    LT_ACCESS_KEY: 'env-key',
  });
  assert.equal(captured.read(), basic('opt-user', 'env-key'));
});
