import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertSecureCredentialSocket,
  assertSecureCredentialTransport,
} from './credential-transport.ts';
import { isLoopbackHostname } from './loopback-host.ts';

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
  expect(assertSecureCredentialTransport(url, 'Remote daemon base URL').href).toBe(
    new URL(url).href,
  );
});

test.each([
  'http://fleet.example.test/agent-device',
  'http://10.0.0.7:4310',
  'http://0.0.0.0:4310',
  'http://localhost.:4310',
  'ws://127.0.0.1:4310',
  'http:',
])('a credential never travels to %s', (url) => {
  let refusal: unknown;
  try {
    assertSecureCredentialTransport(url, 'Remote daemon base URL');
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(AppError);
  expect((refusal as AppError).code).toBe('INVALID_ARGS');
  expect((refusal as AppError).details?.reason).toBe('insecure_credential_transport');
});

test.each([
  ['wss://bridge.example.test/bridge?ticket=t', 'https:'],
  ['https://bridge.example.test/bridge', 'https:'],
  ['ws://127.0.0.1:4310/bridge?ticket=t', 'http:'],
  ['WS://[::1]:4310/bridge', 'http:'],
  ['http://localhost:4310/bridge', 'http:'],
])('a credential socket may open to %s', (url, protocol) => {
  expect(assertSecureCredentialSocket(url, 'Bridge socket URL').protocol).toBe(protocol);
});

test.each([
  'ws://bridge.example.test/bridge?ticket=t',
  'ws://10.0.0.7:4310/bridge',
  'http://bridge.example.test/bridge',
  'ftp://127.0.0.1/bridge',
  'ws:',
])('a credential socket never opens to %s', (url) => {
  expect(() => assertSecureCredentialSocket(url, 'Bridge socket URL')).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'insecure_credential_transport' }),
    }),
  );
});
