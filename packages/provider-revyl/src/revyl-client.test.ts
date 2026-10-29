import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { REVYL_DEFAULT_BACKEND_URL, resolveRevylBackendUrl } from './revyl-client.ts';

test('uses the public Revyl backend when no URL is configured', () => {
  assert.equal(REVYL_DEFAULT_BACKEND_URL, 'https://backend.revyl.ai');
  assert.equal(resolveRevylBackendUrl('https://backend.revyl.ai/'), REVYL_DEFAULT_BACKEND_URL);
});

test('keeps plain HTTP only on loopback', () => {
  assert.equal(resolveRevylBackendUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(resolveRevylBackendUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.throws(
    () => resolveRevylBackendUrl('http://backend.revyl.ai'),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'invalid_provider_url',
  );
});

test('refuses an URL that carries credentials, a query, or a fragment', () => {
  for (const value of [
    'https://key@backend.revyl.ai',
    'https://backend.revyl.ai/?key=secret',
    'https://backend.revyl.ai#token',
    'not a url',
  ]) {
    assert.throws(
      () => resolveRevylBackendUrl(value),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'invalid_provider_url',
      value,
    );
  }
});
