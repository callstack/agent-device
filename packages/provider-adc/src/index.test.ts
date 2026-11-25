import { afterEach, expect, it, vi } from 'vitest';
import type { PluginConnectionContext } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import adc from './index.ts';
import { adcClient, credentials } from './client.ts';

function context(
  env: NodeJS.ProcessEnv,
  flags: Partial<PluginConnectionContext['flags']>,
): PluginConnectionContext {
  return {
    env,
    flags: { json: false, help: false, version: false, ...flags },
    cwd: '.',
    stateDir: '.',
    host: {
      env,
      options: {},
      diagnostics: { emit: () => {} },
      runHostCommand: vi.fn(),
      clientVersion: 'test',
      createError: (code, message, details) => new AppError(code, message, details),
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

it('verifies a direct workspace key without creating a lease and configures a TV profile', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'workspace' }));
  vi.stubGlobal('fetch', fetch);
  const [plugin] = adc().contributes;
  const request = context(
    { ADC_API_KEY: 'workspace-token' },
    { platform: 'android', target: 'tv' },
  );
  const result = await plugin.connection?.resolve(request);
  expect(result?.profile).toMatchObject({
    leaseProvider: 'adc',
    platform: 'android',
    target: 'tv',
  });
  const verification = await plugin.connection?.verify(request);
  expect(verification?.verificationMessage).toBe('ADC workspace key verified.');
  expect(fetch).toHaveBeenCalledTimes(1);
  const call = fetch.mock.calls[0];
  if (!call) throw new Error('Expected the credential verification request.');
  const [url, options] = call;
  expect(url.pathname).toBe('/v1/me');
  expect(options.headers.authorization).toBe('Bearer workspace-token');
});

it('sets up an attached phone without using workspace credentials or contacting the vendor', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const env = {
    ADC_ADB_WEBSOCKET_URL: 'wss://adc.test/v2/leases/device/adb',
    ADC_LEASE_TOKEN: 'lease',
  };
  const request = context(env, {});
  const [plugin] = adc().contributes;
  const result = await plugin.connection?.resolve(request);
  expect(result?.profile.target).toBe('mobile');
  const verification = await plugin.connection?.verify(request);
  expect(verification?.verificationMessage).toBe('ADC lease endpoint configured.');
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects mixed credentials, plaintext remote endpoints, and unsupported selectors', async () => {
  const env = { ADC_API_KEY: 'workspace' };
  expect(() => credentials({})).toThrow('ADC_API_KEY');
  expect(() => credentials({ ...env, ADC_LEASE_TOKEN: 'one' })).toThrow('attached ADC device');
  expect(() => credentials({ ...env, ADC_API_URL: 'http://example.test' })).toThrow(
    'secure endpoint',
  );
  const [plugin] = adc().contributes;
  const connection = plugin.connection;
  for (const flags of [
    { platform: 'ios' },
    { target: 'desktop' },
    { providerProject: 'foreign' },
  ] as const) {
    const request = context(env, flags);
    expect(() => connection?.resolve(request)).toThrow();
  }
});

it('checks the returned access URL is bound to the requested lease and origin', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const client = adcClient({
    kind: 'direct',
    origin: new URL('https://adc.test'),
    key: 'workspace',
  });
  const signal = new AbortController().signal;
  for (const url of [
    'wss://adc.test/v2/leases/other/adb',
    'wss://elsewhere.test/v2/leases/one/adb',
  ]) {
    fetch.mockResolvedValueOnce(Response.json({ websocket_url: url, token: 'lease' }));
    await expect(client.access('one', signal)).rejects.toThrow('different endpoint');
  }
  fetch.mockResolvedValueOnce(Response.json({}));
  await expect(client.access('one', signal)).rejects.toThrow('invalid ADB credentials');
});

it('leaves the installed plugin dormant until credentials are configured', async () => {
  const [plugin] = adc().contributes;
  const { host } = context({}, {});
  const result = await plugin.setup(host);
  expect(result).toHaveProperty('dormant');
  const incomplete = context({ ADC_LEASE_TOKEN: 'lease' }, {});
  await expect(plugin.setup(incomplete.host)).rejects.toThrow('attached ADC device');
});
