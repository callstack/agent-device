import { expect, test } from 'vitest';
import {
  providerCredentialFingerprint,
  readDaemonProviderCredentials,
} from './provider-credential-fingerprint.ts';

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
    expect(readDaemonProviderCredentials({}, '/state').fingerprints[provider]).toBe(undefined);
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
  expect(providerCredentialFingerprint('constructor', BROWSERSTACK_ENV)).toBe(undefined);
});

test('AWS Device Farm has no environment fingerprint', () => {
  expect(providerCredentialFingerprint('aws-device-farm', { AWS_ACCESS_KEY_ID: 'id' })).toBe(
    undefined,
  );
  expect(Object.keys(readDaemonProviderCredentials({}, '/state').fingerprints).sort()).toEqual([
    'browserstack',
    'limrun',
  ]);
});

test('a fingerprint never contains a credential value', () => {
  const fingerprints = JSON.stringify(
    readDaemonProviderCredentials({ ...BROWSERSTACK_ENV, LIMRUN_API_KEY: 'lim-key' }, '/state'),
  );
  for (const value of ['user', 'key-1', 'lim-key']) expect(fingerprints).not.toContain(value);
});
