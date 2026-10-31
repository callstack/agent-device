import { expect, test } from 'vitest';
import type { ProviderPluginHost } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import { resolveProviderPlugins, startProviderRegistry } from '@agent-device/plugins/registry';
import nomac from './index.ts';

const host = (env: Record<string, string | undefined>): ProviderPluginHost => ({
  env,
  options: {},
  clientVersion: '0.0.0-test',
  createError: (code, message, details) => new AppError(code, message, details),
});

test('the plugin declares itself as agent-device version 2 expects, reading NOMAC_API_KEY and NOMAC_API_URL', () => {
  const plugin = nomac();
  expect(plugin).toMatchObject({
    apiVersion: 2,
    provider: 'nomac',
    credentials: { variables: ['NOMAC_API_KEY', 'NOMAC_API_URL'] },
  });
  expect(plugin.connection?.capabilities).toMatchObject({
    leaseKind: 'direct-device-provider',
    requiresRemoteDaemon: false,
    supportsDeferredAppSelection: false,
    usesCloudWebDriverLease: false,
  });
  expect(nomac({ apiKey: 'nmk_x' }).credentials.variables).toEqual(['NOMAC_API_URL']);
  expect(nomac({ baseUrl: 'https://nomac.test' }).credentials.variables).toEqual(['NOMAC_API_KEY']);
  expect(nomac({ apiKey: 'nmk_x', baseUrl: 'https://nomac.test' }).credentials.variables).toEqual(
    [],
  );
});

test("agent-device's own registry validates the plugin and registers its runtime, with or without a key", async () => {
  for (const env of [{ NOMAC_API_KEY: 'nmk_test' }, {}]) {
    const resolved = await resolveProviderPlugins([
      { source: 'store', package: '@agent-device/nomac', load: () => nomac() },
    ]);
    const registry = await startProviderRegistry(resolved, env, {
      adaptWebDriver: async () => {
        throw new Error('not a WebDriver plugin');
      },
    });
    expect(registry.inventory.map((entry) => [entry.provider, entry.state])).toEqual([
      ['nomac', 'active'],
    ]);
    expect(registry.registrations[0]?.runtime.provider).toBe('nomac');
    expect(registry.registrations[0]?.platformModule.owner).toMatchObject({
      kind: 'provider-runtime',
      provider: 'nomac',
    });
    await registry.close();
  }
});

test('connect resolves a profile without starting a phone, and refuses what NoMac cannot serve', async () => {
  const plugin = nomac();
  const context = (
    flags: Record<string, unknown>,
    env: Record<string, string | undefined> = { NOMAC_API_KEY: 'nmk_test' },
  ) => ({ flags, env, cwd: '/tmp', stateDir: '/tmp', host: host(env) }) as never;
  // The model's name is saved: the name the lease's device carries, so `--device` selects it.
  expect(await plugin.connection!.resolve(context({ device: 'ipad' }))).toEqual({
    profile: { leaseProvider: 'nomac', platform: 'ios', device: 'iPad Pro 11-inch (M5)' },
  });
  await expect(
    async () => await plugin.connection!.resolve(context({ providerDeviceType: 'real' })),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  await expect(
    async () => await plugin.connection!.resolve(context({ platform: 'android' })),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  await expect(
    async () => await plugin.connection!.resolve(context({ providerApp: 'bs://x' })),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  await expect(async () => await plugin.connection!.resolve(context({}, {}))).rejects.toMatchObject(
    { code: 'INVALID_ARGS', message: expect.stringMatching(/NOMAC_API_KEY/) },
  );
});

test('verify checks the key against the address the options or NOMAC_API_URL name', async () => {
  const hosts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    hosts.push(new URL(String(input)).origin);
    return Response.json({ sessions: [] });
  }) as typeof globalThis.fetch;
  try {
    const env = { NOMAC_API_KEY: 'nmk_test' };
    await nomac({ baseUrl: 'https://staging.nomac.test' }).connection!.verify({
      flags: {},
      env,
      host: host(env),
    } as never);
    const fromEnv = { NOMAC_API_KEY: 'nmk_test', NOMAC_API_URL: 'https://other.nomac.test' };
    await nomac().connection!.verify({ flags: {}, env: fromEnv, host: host(fromEnv) } as never);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(hosts).toEqual(['https://staging.nomac.test', 'https://other.nomac.test']);
});
