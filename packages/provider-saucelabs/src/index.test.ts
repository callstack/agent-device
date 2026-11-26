import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { ProviderPluginHost } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import saucelabs from './index.ts';
import manifest from '../package.json' with { type: 'json' };

const JOB_ID = '0123456789abcdef0123456789abcdef';

afterEach(() => vi.unstubAllGlobals());

function host(env: Record<string, string | undefined>): ProviderPluginHost {
  return {
    env,
    options: {},
    clientVersion: '0.0.0-test',
    createError: (code, message, details) => new AppError(code, message, details),
  };
}

const basic = (username: string, accessKey: string) =>
  `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;

async function lookupAuthorization(
  plugin: ReturnType<typeof saucelabs>,
  env: Record<string, string>,
): Promise<string | undefined> {
  let authorization: string | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization') ?? undefined;
      return new Response(JSON.stringify({ id: JOB_ID, status: 'in progress' }));
    }),
  );
  const setup = await plugin.setup(host(env));
  if (!('webDriver' in setup)) throw new Error('Sauce Labs sets up a WebDriver descriptor');
  await setup.webDriver.listArtifacts!({ provider: 'saucelabs', providerSessionId: JOB_ID });
  return authorization;
}

// The region decides where the credentials are sent, so a daemon started for another data center
// must count as holding different credentials.
test('the plugin fingerprints SAUCE_REGION with the credential variables it reads', () => {
  assert.deepEqual(saucelabs().credentials, {
    variables: ['SAUCE_USERNAME', 'SAUCE_ACCESS_KEY', 'SAUCE_REGION'],
  });
  assert.deepEqual(saucelabs({ credentials: { username: 'u', accessKey: 'k' } }).credentials, {
    variables: ['SAUCE_REGION'],
  });
  assert.deepEqual(manifest.agentDevicePlugin.credentialVariables, [
    'SAUCE_USERNAME',
    'SAUCE_ACCESS_KEY',
    'SAUCE_REGION',
  ]);
  assert.equal(manifest.agentDevicePlugin.provider, saucelabs().provider);
});

test('credentials passed as options replace the environment, which stays the fallback', async () => {
  const env = { SAUCE_USERNAME: 'env-user', SAUCE_ACCESS_KEY: 'env-key' };
  assert.equal(
    await lookupAuthorization(saucelabs({ credentials: { username: 'o', accessKey: 'p' } }), env),
    basic('o', 'p'),
  );
  assert.equal(await lookupAuthorization(saucelabs(), env), basic('env-user', 'env-key'));
  await assert.rejects(lookupAuthorization(saucelabs(), {}), { code: 'INVALID_ARGS' });
});
