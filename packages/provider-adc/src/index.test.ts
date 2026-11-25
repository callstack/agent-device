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
    ADC_API_URL: 'https://adc.test',
    ADC_ADB_WEBSOCKET_URL: 'wss://adc.test/v2/leases/a0000000-0000-4000-8000-000000000001/adb',
    ADC_LEASE_TOKEN: 'lease',
  };
  const request = context(env, { providerNetworkLogs: false, providerProject: '' });
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
    'wss://adc.test/v2/leases/b0000000-0000-4000-8000-000000000002/adb',
    'wss://elsewhere.test/v2/leases/a0000000-0000-4000-8000-000000000001/adb',
  ]) {
    fetch.mockResolvedValueOnce(Response.json({ websocket_url: url, token: 'lease' }));
    await expect(client.access('a0000000-0000-4000-8000-000000000001', signal)).rejects.toThrow(
      'different endpoint',
    );
  }
  fetch.mockResolvedValueOnce(Response.json({}));
  await expect(client.access('a0000000-0000-4000-8000-000000000001', signal)).rejects.toThrow(
    'invalid ADB credentials',
  );
});

it('leaves the installed plugin dormant until credentials are configured', async () => {
  const [plugin] = adc().contributes;
  const { host } = context({}, {});
  const result = await plugin.setup(host);
  expect(result).toHaveProperty('dormant');
  const incomplete = context({ ADC_LEASE_TOKEN: 'lease' }, {});
  await expect(plugin.setup(incomplete.host)).rejects.toThrow('attached ADC device');
});

it('binds attached credentials to the configured encrypted origin before opening a socket', () => {
  const id = 'a0000000-0000-4000-8000-000000000001';
  const env = {
    ADC_API_URL: 'https://adc.test',
    ADC_LEASE_TOKEN: 'scoped',
    ADC_ADB_WEBSOCKET_URL: 'wss://adc.test/v2/leases/' + id + '/adb',
  };
  for (const invalid of [
    { ...env, ADC_API_URL: 'http://127.0.0.1' },
    { ...env, ADC_ADB_WEBSOCKET_URL: 'ws://127.0.0.1/v2/leases/' + id + '/adb' },
    { ...env, ADC_ADB_WEBSOCKET_URL: 'wss://other.test/v2/leases/' + id + '/adb' },
    { ...env, ADC_LEASE_TOKEN: id },
    { ...env, ADC_LEASE_TOKEN: 'secret\r\nvalue' },
    { ADC_API_KEY: 'hidden\nkey' },
  ])
    expect(() => credentials(invalid)).toThrow();
});

it('keeps upstream response bodies, unknown states and header failures out of errors', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const client = adcClient({
    kind: 'direct',
    origin: new URL('https://adc.test'),
    key: 'hidden-key',
  });
  const id = 'a0000000-0000-4000-8000-000000000001';
  const signal = new AbortController().signal;
  fetch.mockResolvedValueOnce(new Response('hidden-key'));
  await expect(client.get(id, signal)).rejects.toThrow(/^ADC returned invalid JSON\.$/);
  fetch.mockResolvedValueOnce(Response.json({ id, status: 'hidden-key' }));
  await expect(client.get(id, signal)).rejects.toThrow(/^ADC returned an invalid lease\.$/);
  fetch.mockResolvedValueOnce(
    Response.json({ id: 'b0000000-0000-4000-8000-000000000002', status: 'active' }),
  );
  await expect(client.get(id, signal)).rejects.toThrow(/^ADC returned a different lease\.$/);
  fetch.mockRejectedValueOnce(new Error('hidden-key'));
  await expect(client.verify()).rejects.toThrow(/^ADC request did not complete\.$/);
});

it('keeps release pending until ADC confirms this booking ended', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const client = adcClient({
    kind: 'direct',
    origin: new URL('https://adc.test'),
    key: 'workspace',
  });
  const id = 'a0000000-0000-4000-8000-000000000001';
  const foreign = 'b0000000-0000-4000-8000-000000000002';
  for (const response of [
    new Response(null, { status: 202 }),
    Response.json({ id, status: 'active' }),
    Response.json({ id: foreign, status: 'released' }),
  ]) {
    fetch.mockResolvedValueOnce(response);
    await expect(client.end(id)).rejects.toThrow();
  }
  fetch.mockResolvedValueOnce(Response.json({ id, status: 'released' }));
  await expect(client.end(id)).resolves.toBeUndefined();
});
