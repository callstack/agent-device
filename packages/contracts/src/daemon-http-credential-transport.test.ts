import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { assertSecureCredentialTransport, isLoopbackHostname } from './daemon-http.ts';

test('loopback hostnames are recognized in each spelling a base URL carries', () => {
  expect(isLoopbackHostname('LocalHost ')).toBe(true);
  expect(isLoopbackHostname('127.0.0.1')).toBe(true);
  expect(isLoopbackHostname('[::1]')).toBe(true);
  expect(isLoopbackHostname('::ffff:127.0.0.1')).toBe(true);
  expect(isLoopbackHostname('0.0.0.0')).toBe(false);
  expect(isLoopbackHostname('127.1.2.3')).toBe(true);
  expect(isLoopbackHostname('localhost.example.test')).toBe(false);
  expect(isLoopbackHostname('')).toBe(false);
});

test.each([
  'https://fleet.example.test/agent-device',
  'https://10.0.0.7:4310',
  'http://127.0.0.1:4310/agent-device',
  'http://[::1]:4310',
  'http://localhost:4310',
])('a credential may travel to %s', (url) => {
  expect(() => assertSecureCredentialTransport(url, 'Remote daemon base URL')).not.toThrow();
});

test.each([
  'http://fleet.example.test/agent-device',
  'http://10.0.0.7:4310',
  'http://0.0.0.0:4310',
])('a credential never travels over plain http to %s', (url) => {
  let refusal: unknown;
  try {
    assertSecureCredentialTransport(url, 'Remote daemon base URL');
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(AppError);
  expect((refusal as AppError).code).toBe('INVALID_ARGS');
  expect((refusal as AppError).details).toMatchObject({
    reason: 'insecure_credential_transport',
    origin: new URL(url).origin,
  });
});
