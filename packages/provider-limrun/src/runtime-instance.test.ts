import { expect, test } from 'vitest';
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
