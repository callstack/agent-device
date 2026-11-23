import { expect, test, vi } from 'vitest';
import { limrunPlugin } from './plugin.ts';
import { stubLimrunRuntimeDependencies } from './runtime-dependencies.fixtures.ts';
import { resolveLimrunRuntimeInstance } from './runtime-instance.ts';

test('derives a stable opaque identity without exposing the API key', () => {
  const first = resolveLimrunRuntimeInstance({ apiKey: 'secret-key', region: ' EU ' });
  const same = resolveLimrunRuntimeInstance({ apiKey: 'secret-key', region: 'eu' });
  const changed = resolveLimrunRuntimeInstance({ apiKey: 'another-key', region: 'eu' });
  expect(first).toBe(same);
  expect(changed).not.toBe(first);
  expect(first).not.toContain('secret-key');
});

test('uses and validates an explicit composition identity', () => {
  expect(resolveLimrunRuntimeInstance({ apiKey: 'secret', runtimeInstance: ' account-a ' })).toBe(
    'account-a',
  );
  expect(() => resolveLimrunRuntimeInstance({ apiKey: 'secret', runtimeInstance: ' ' })).toThrow(
    'non-empty',
  );
});

test('derives an identity from attached instances without an API key', () => {
  const ios = { apiUrl: 'https://attached.example/api', token: 'instance-token' };
  const attached = resolveLimrunRuntimeInstance({ instances: { ios } });
  expect(attached).not.toBe(
    resolveLimrunRuntimeInstance({ instances: { ios: { ...ios, apiUrl: 'x' } } }),
  );
  expect(resolveLimrunRuntimeInstance({ apiKey: 'k', instances: {} })).toBe(
    resolveLimrunRuntimeInstance({ apiKey: 'k' }),
  );
});

/**
 * Durable app-log descriptors name the instance a Limrun runtime derived, so these digests are the
 * contract: field names, field order, and region normalization all feed them. The values are the ones
 * Limrun derived before the fingerprint moved to `providerRuntimeInstance`.
 */
test('keeps the durable digest of an account and of an attached instance', () => {
  expect(resolveLimrunRuntimeInstance({ apiKey: 'secret-key', region: ' EU ' })).toBe(
    'principal-1426b5849137d86f197cdb796882e8f619e8be77eda1b424144502e1da55af29',
  );
  expect(
    resolveLimrunRuntimeInstance({
      apiKey: 'secret-key',
      instances: { ios: { apiUrl: 'https://attached.example/api', token: 't' } },
    }),
  ).toBe('principal-5e4bdc0668a05c1c16f984e4655fc1d1a3bcd25b5965e3b9f3a40838121d5110');
});

test('rental recovery binds effective authorization and API URL independently of model settings', async () => {
  const [provider] = limrunPlugin({
    createDependencies: stubLimrunRuntimeDependencies,
  }).contributes;
  if (provider.kind !== 'provider') throw new Error('Expected the Limrun provider');
  const principal = async (env: Record<string, string>) => {
    const setup = await provider.setup({
      env,
      options: {},
      clientVersion: 'test-version',
      diagnostics: { emit: () => {} },
      createError: (_code, message) => {
        throw new Error(message);
      },
      runHostCommand: async () => {
        throw new Error('Expected no host command');
      },
    });
    if (!('runtime' in setup)) throw new Error('Expected a configured Limrun runtime');
    return setup.runtime.rentalRecoveryPrincipal;
  };
  vi.stubEnv('LIMRUN_BASE_URL', 'https://a.example.test');
  vi.stubEnv('LIMRUN_CUSTOM_HEADERS', undefined);
  try {
    const first = await principal({ LIMRUN_API_KEY: 'fixture-key', LIMRUN_IOS_MODEL: 'iphone' });
    expect(first).toMatch(/^principal-[a-f0-9]{64}$/);
    expect(
      await principal({
        LIMRUN_API_KEY: 'fixture-key',
        LIMRUN_IOS_MODEL: 'ipad',
        LIMRUN_KEEP_ALIVE: '1',
      }),
    ).toBe(first);
    expect(await principal({ LIMRUN_API_KEY: 'other-key' })).not.toBe(first);

    vi.stubEnv('LIMRUN_BASE_URL', 'https://b.example.test');
    expect(await principal({ LIMRUN_API_KEY: 'fixture-key' })).not.toBe(first);
    vi.stubEnv('LIMRUN_BASE_URL', 'https://a.example.test');
    vi.stubEnv('LIMRUN_CUSTOM_HEADERS', 'Authorization: Bearer alternate-fixture-credential');
    expect(await principal({ LIMRUN_API_KEY: 'fixture-key' })).not.toBe(first);
    vi.stubEnv('LIMRUN_CUSTOM_HEADERS', 'X-Account: account-a\nX-Route: region-a');
    const routed = await principal({ LIMRUN_API_KEY: 'fixture-key' });
    expect(routed).not.toBe(first);
    vi.stubEnv('LIMRUN_CUSTOM_HEADERS', 'X-Route: region-a\nX-Account: account-a');
    expect(await principal({ LIMRUN_API_KEY: 'fixture-key' })).toBe(routed);
    vi.stubEnv('LIMRUN_CUSTOM_HEADERS', 'X-Account: account-b\nX-Route: region-a');
    expect(await principal({ LIMRUN_API_KEY: 'fixture-key' })).not.toBe(routed);
    expect(
      await principal({
        LIM_IOS_INSTANCE_URL: 'https://attached.example.test',
        LIM_IOS_INSTANCE_TOKEN: 'fixture-token',
      }),
    ).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

test('keeps Limrun registered when the SDK cannot build recovery proof', async () => {
  const [provider] = limrunPlugin({
    createDependencies: stubLimrunRuntimeDependencies,
  }).contributes;
  if (provider.kind !== 'provider') throw new Error('Expected the Limrun provider');
  vi.stubEnv('LIMRUN_CUSTOM_HEADERS', 'Invalid Header Name: fixture');
  try {
    const setup = await provider.setup({
      env: { LIMRUN_API_KEY: 'fixture-key' },
      options: {},
      clientVersion: 'test-version',
      diagnostics: { emit: () => {} },
      createError: (_code, message) => {
        throw new Error(message);
      },
      runHostCommand: async () => {
        throw new Error('Expected no host command');
      },
    });
    if (!('runtime' in setup)) throw new Error('Expected a configured Limrun runtime');
    expect(setup.runtime.provider).toBe('limrun');
    expect(setup.runtime.rentalRecoveryPrincipal).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});
