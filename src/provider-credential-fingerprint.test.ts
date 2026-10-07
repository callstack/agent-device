import { expect, test } from 'vitest';
import {
  providerCredentialFingerprint,
  readDaemonProviderCredentials,
} from './provider-credential-fingerprint.ts';
import { pluginHome, selectPluginManifest } from './plugins/plugin.fixtures.ts';

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
  expect(providerCredentialFingerprint('limrun', { LIMRUN_API_KEY: ' lim-key ' })).toBe(limrun);
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

function pluginWithCredentialVariables(credentialVariables?: string[], provider = 'example') {
  const { home, env } = pluginHome();
  selectPluginManifest(home, {
    name: '@example/provider',
    version: '1.2.3',
    agentDevicePlugin: { apiVersion: 1, provider, entry: './plugin.js', credentialVariables },
  });
  return env;
}

test('a plugin provider fingerprint hashes the variables its manifest declares', () => {
  const home = pluginWithCredentialVariables(['EXAMPLE_USER', 'EXAMPLE_KEY']);
  const env = { ...home, EXAMPLE_USER: 'user', EXAMPLE_KEY: 'key-1' };
  const fingerprint = providerCredentialFingerprint('example', env);

  expect(fingerprint).toMatch(/^v1:[0-9a-f]{16}$/);
  expect(providerCredentialFingerprint('example', { ...env, UNRELATED: 'x' })).toBe(fingerprint);
  expect(providerCredentialFingerprint('example', { ...env, EXAMPLE_KEY: 'key-2' })).not.toBe(
    fingerprint,
  );
  expect(providerCredentialFingerprint('example', { ...env, EXAMPLE_KEY: 'key-1 ' })).not.toBe(
    fingerprint,
  );
  expect(providerCredentialFingerprint('example', { ...home, EXAMPLE_USER: ' ' })).toBe(undefined);
  expect(readDaemonProviderCredentials(env, '/state').fingerprint('example')).toBe(fingerprint);
});

test('a plugin provider without declared credential variables has no fingerprint', () => {
  const env = { ...pluginWithCredentialVariables(), EXAMPLE_USER: 'user' };
  expect(providerCredentialFingerprint('example', env)).toBe(undefined);
  expect(providerCredentialFingerprint('other', env)).toBe(undefined);
});

test('a plugin declaration never adds a fingerprint to a bundled provider', () => {
  const env = {
    ...pluginWithCredentialVariables(['AWS_ACCESS_KEY_ID'], 'aws-device-farm'),
    AWS_ACCESS_KEY_ID: 'id',
  };
  expect(providerCredentialFingerprint('aws-device-farm', env)).toBe(undefined);
});
