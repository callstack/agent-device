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
