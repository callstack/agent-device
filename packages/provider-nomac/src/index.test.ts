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

test('the plugin declares itself as agent-device version 2 expects, reading only NOMAC_API_KEY', () => {
  const plugin = nomac();
  expect(plugin).toMatchObject({
    apiVersion: 2,
    provider: 'nomac',
    credentials: { variables: ['NOMAC_API_KEY'] },
  });
  expect(plugin.connection?.capabilities).toMatchObject({
    leaseKind: 'direct-device-provider',
    requiresRemoteDaemon: false,
    usesCloudWebDriverLease: false,
  });
  expect(nomac({ apiKey: 'nmk_x' }).credentials.variables).toEqual([]);
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
  expect(await plugin.connection!.resolve(context({ device: 'ipad' }))).toEqual({
    profile: { leaseProvider: 'nomac', platform: 'ios', device: 'ipad' },
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
