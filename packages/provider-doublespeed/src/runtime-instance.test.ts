import { expect, test } from 'vitest';
import { resolveDoublespeedRuntimeInstance } from './runtime-instance.ts';

test('derives a stable opaque identity without exposing the API key', () => {
  const first = resolveDoublespeedRuntimeInstance({ apiKey: 'secret-key' });
  const same = resolveDoublespeedRuntimeInstance({
    apiKey: 'secret-key',
    apiUrl: 'https://API.mac.doublespeed.ai/',
  });
  const changed = resolveDoublespeedRuntimeInstance({ apiKey: 'another-key' });
  const otherHost = resolveDoublespeedRuntimeInstance({
    apiKey: 'secret-key',
    apiUrl: 'https://staging.example',
  });
  expect(first).toBe(same);
  expect(changed).not.toBe(first);
  expect(otherHost).not.toBe(first);
  expect(first).not.toContain('secret-key');
});

test('uses and validates an explicit composition identity', () => {
  expect(
    resolveDoublespeedRuntimeInstance({ apiKey: 'secret', runtimeInstance: ' account-a ' }),
  ).toBe('account-a');
  expect(() =>
    resolveDoublespeedRuntimeInstance({ apiKey: 'secret', runtimeInstance: ' ' }),
  ).toThrow('non-empty');
});
