import { expect, test } from 'vitest';
import { providerCredentialFingerprint as fingerprintFor } from '@agent-device/plugins/credential-fingerprint';
import { readDaemonProviderCredentials as daemonCredentialsFor } from './provider-credential-fingerprint.ts';
import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { builtinPluginInventory } from './__tests__/test-utils/builtin-plugin-inventory.ts';
import { pluginHome, selectV2Plugin, v2RegistrationSource } from '@agent-device/test-kit';
import { BUILTIN_PROVIDER_IDS } from './builtin-provider-ids.ts';

const inventory = await builtinPluginInventory();
const providerCredentialFingerprint = (
  provider: string,
  env: EnvMap,
  leaseBackend?: string,
  inventoryOverride?: readonly PluginInventoryEntry[],
) => fingerprintFor(provider, env, leaseBackend, inventoryOverride ?? inventory);
const readDaemonProviderCredentials = (env: EnvMap, stateDir: string) =>
  daemonCredentialsFor(env, stateDir, inventory);

const BROWSERSTACK_ENV = { BROWSERSTACK_USERNAME: 'user', BROWSERSTACK_ACCESS_KEY: 'key-1' };

test.for([
  ['limrun', { LIMRUN_API_KEY: 'lim-key' }, { LIMRUN_API_KEY: 'lim-rotated' }],
  [
    'limrun',
    { LIMRUN_API_KEY: 'lim-key' },
    {
      LIMRUN_API_KEY: 'lim-key',
      LIM_IOS_INSTANCE_URL: 'https://region.limrun.example/v1/ios_x/api',
      LIM_IOS_INSTANCE_TOKEN: 'ios-token',
    },
  ],
  ['browserstack', BROWSERSTACK_ENV, { ...BROWSERSTACK_ENV, BROWSERSTACK_ACCESS_KEY: 'key-2' }],
] as const)('%s fingerprint changes with its credential variables', ([provider, before, after]) => {
  const fingerprint = providerCredentialFingerprint(provider, before);
  expect(fingerprint).toMatch(/^v1:[0-9a-f]{16}$/);
  expect(providerCredentialFingerprint(provider, { ...before })).toBe(fingerprint);
  expect(providerCredentialFingerprint(provider, after)).not.toBe(fingerprint);
});

test('provider whitespace does not bypass credential fingerprinting', () => {
  const first = providerCredentialFingerprint('limrun', { LIMRUN_API_KEY: 'first' });
  expect(first).toBeDefined();
  expect(providerCredentialFingerprint('  limrun  ', { LIMRUN_API_KEY: 'first' })).toBe(first);
  expect(providerCredentialFingerprint('  limrun  ', { LIMRUN_API_KEY: 'second' })).not.toBe(first);
});

test('a fingerprint ignores variables the provider does not read and blank values', () => {
  const fingerprint = providerCredentialFingerprint('browserstack', BROWSERSTACK_ENV);
  expect(
    providerCredentialFingerprint('browserstack', {
      ...BROWSERSTACK_ENV,
      LIMRUN_API_KEY: 'lim-key',
      BROWSERSTACK_WEBDRIVER_ENDPOINT: 'https://hub.example',
    }),
  ).toBe(fingerprint);
});

test.for(['limrun', 'browserstack'])(
  'neither a caller nor a daemon without %s credentials has a fingerprint',
  (provider) => {
    expect(providerCredentialFingerprint(provider, {})).toBe(undefined);
    expect(providerCredentialFingerprint(provider, { LIMRUN_REGION: ' ' })).toBe(undefined);
    expect(readDaemonProviderCredentials({}, '/state').fingerprint(provider)).toBe(undefined);
  },
);

test('a fingerprint hashes the exact values each provider reads', () => {
  const browserstack = providerCredentialFingerprint('browserstack', BROWSERSTACK_ENV);
  expect(
    providerCredentialFingerprint('browserstack', {
      ...BROWSERSTACK_ENV,
      BROWSERSTACK_ACCESS_KEY: 'key-1 ',
    }),
  ).not.toBe(browserstack);
  const limrun = providerCredentialFingerprint('limrun', { LIMRUN_API_KEY: 'lim-key' });
  expect(providerCredentialFingerprint('limrun', { LIMRUN_API_KEY: ' lim-key ' })).not.toBe(limrun);
});

test('a provider name that only matches an inherited object key has no fingerprint', () => {
  const env = { ...pluginHome().env, ...BROWSERSTACK_ENV };
  expect(providerCredentialFingerprint('constructor', env)).toBe(undefined);
});

test('AWS Device Farm has no environment fingerprint', () => {
  const env = { AWS_ACCESS_KEY_ID: 'id' };
  expect(providerCredentialFingerprint('aws-device-farm', env)).toBe(undefined);
  expect(readDaemonProviderCredentials(env, '/state').fingerprint('aws-device-farm')).toBe(
    undefined,
  );
});

test('a fingerprint never contains a credential value', () => {
  const daemon = readDaemonProviderCredentials(
    { ...BROWSERSTACK_ENV, LIMRUN_API_KEY: 'lim-key' },
    '/state',
  );
  const fingerprints = JSON.stringify([
    daemon.fingerprint('browserstack'),
    daemon.fingerprint('limrun'),
  ]);
  for (const value of ['user', 'key-1', 'lim-key']) expect(fingerprints).not.toContain(value);
});

const IOS_ATTACH = {
  LIM_IOS_INSTANCE_URL: 'https://region.limrun.example/v1/ios_x/api',
  LIM_IOS_INSTANCE_TOKEN: 'ios-token',
};
const ANDROID_ATTACH = {
  LIM_ANDROID_INSTANCE_URL: 'https://region.limrun.example/v1/android_x/api',
  LIM_ANDROID_INSTANCE_TOKEN: 'android-token',
  LIM_ANDROID_INSTANCE_ADB_URL: 'wss://region.limrun.example/v1/android_x/adb',
};

test('a Limrun lease fingerprint covers only the leased platform and the account', () => {
  const before = { LIMRUN_API_KEY: 'lim-key', ...IOS_ATTACH, ...ANDROID_ATTACH };
  const rotatedAndroid = { ...before, LIM_ANDROID_INSTANCE_TOKEN: 'android-token-2' };
  const ios = (env: Record<string, string>) =>
    providerCredentialFingerprint('limrun', env, 'ios-instance');
  const android = (env: Record<string, string>) =>
    providerCredentialFingerprint('limrun', env, 'android-instance');

  expect(ios(rotatedAndroid)).toBe(ios(before));
  expect(android(rotatedAndroid)).not.toBe(android(before));
  expect(ios({ ...before, LIMRUN_API_KEY: 'lim-rotated' })).not.toBe(ios(before));
  expect(providerCredentialFingerprint('limrun', rotatedAndroid)).not.toBe(
    providerCredentialFingerprint('limrun', before),
  );
  expect(
    readDaemonProviderCredentials(before, '/state').fingerprint('limrun', 'ios-instance'),
  ).toBe(ios(rotatedAndroid));
});

/** The inventory the daemon publishes: the built-ins claim their ids, then the store loads. */
async function storeInventory(env: Record<string, string>) {
  const { claimProviderIds, resolveProviderPlugins } =
    await import('@agent-device/plugins/registry');
  const { storePluginCandidates } = await import('@agent-device/plugins/store');
  const resolved = await resolveProviderPlugins([
    ...claimProviderIds(BUILTIN_PROVIDER_IDS),
    ...(await storePluginCandidates(env)),
  ]);
  return resolved.inventory();
}

function pluginWithCredentialVariables(credentialVariables?: string[], provider = 'example') {
  const { home, env } = pluginHome();
  selectV2Plugin(
    home,
    '@example/provider',
    v2RegistrationSource(provider, {
      credentials: `{ variables: ${JSON.stringify(credentialVariables ?? [])} }`,
    }),
  );
  return { env: env as Record<string, string>, home };
}

test('a plugin provider fingerprint hashes the variables its factory declares', async () => {
  const { env: home } = pluginWithCredentialVariables(['EXAMPLE_USER', 'EXAMPLE_KEY']);
  const inventory = await storeInventory(home);
  const env = { ...home, EXAMPLE_USER: 'user', EXAMPLE_KEY: 'key-1' };
  const fingerprint = providerCredentialFingerprint('example', env, undefined, inventory);

  expect(fingerprint).toMatch(/^v1:[0-9a-f]{16}$/);
  expect(
    providerCredentialFingerprint('example', { ...env, UNRELATED: 'x' }, undefined, inventory),
  ).toBe(fingerprint);
  expect(
    providerCredentialFingerprint(
      'example',
      { ...env, EXAMPLE_KEY: 'key-2' },
      undefined,
      inventory,
    ),
  ).not.toBe(fingerprint);
  expect(
    providerCredentialFingerprint(
      'example',
      { ...env, EXAMPLE_KEY: 'key-1 ' },
      undefined,
      inventory,
    ),
  ).not.toBe(fingerprint);
  expect(
    providerCredentialFingerprint('example', { ...home, EXAMPLE_USER: ' ' }, undefined, inventory),
  ).toBe(undefined);
});

test('a plugin provider without declared credential variables has no fingerprint', async () => {
  const { env: home } = pluginWithCredentialVariables();
  const inventory = await storeInventory(home);
  const env = { ...home, EXAMPLE_USER: 'user' };
  expect(providerCredentialFingerprint('example', env, undefined, inventory)).toBe(undefined);
  expect(providerCredentialFingerprint('other', env, undefined, inventory)).toBe(undefined);
});

test('a plugin declaration never adds a fingerprint to a bundled provider', async () => {
  const { env: home } = pluginWithCredentialVariables(['AWS_ACCESS_KEY_ID'], 'aws-device-farm');
  const inventory = await storeInventory(home);
  const env = { ...home, AWS_ACCESS_KEY_ID: 'id' };
  expect(providerCredentialFingerprint('aws-device-farm', env, undefined, inventory)).toBe(
    undefined,
  );
  // The built-in's own answer is unchanged by the store package that claims its id.
  expect(providerCredentialFingerprint('aws-device-farm', env)).toBe(undefined);
});

test('a store plugin declares per-backend credential variables in code', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(
    home,
    '@example/backend',
    v2RegistrationSource('example', {
      credentials:
        '{ variables: ["EXAMPLE_ACCOUNT"], byBackend: { "shared-session": ["EXAMPLE_POOL"] } }',
    }),
  );
  const inventory = await storeInventory(env as Record<string, string>);
  const envMap = { ...env, EXAMPLE_ACCOUNT: 'acct', EXAMPLE_POOL: 'pool-1' };
  const fingerprint = (values: Record<string, string>, leaseBackend?: string) =>
    providerCredentialFingerprint('example', values, leaseBackend, inventory);

  // Without a backend the common variables answer; the pool belongs to one backend only.
  expect(fingerprint(envMap)).toMatch(/^v1:[0-9a-f]{16}$/);
  expect(fingerprint({ ...envMap, EXAMPLE_POOL: 'pool-2' })).toBe(fingerprint(envMap));
  expect(fingerprint({ ...envMap, EXAMPLE_POOL: 'pool-2' }, 'shared-session')).not.toBe(
    fingerprint(envMap, 'shared-session'),
  );
  expect(fingerprint({ EXAMPLE_ACCOUNT: 'acct' }, 'shared-session')).toBe(undefined);
});
