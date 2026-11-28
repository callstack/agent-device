import { expect, test } from 'vitest';
import { credentialTransportRefusal } from './credential-transport.ts';
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
  'http://127.1:4310',
  'http://[::1]:4310',
  'http://[::ffff:127.0.0.1]:4310',
  'http://LOCALHOST:4310',
])('a credential may travel to %s', (url) => {
  expect(credentialTransportRefusal(url, {})).toBeUndefined();
});

test.each([
  'http://fleet.example.test/agent-device',
  'http://10.0.0.7:4310',
  'http://100.64.1.2:4310',
  'http://0.0.0.0:4310',
  'http://localhost.:4310',
  'http://127.0.0.1.nip.io:4310',
  'ws://127.0.0.1:4310',
  'http:',
])('a credential may not travel to %s', (url) => {
  expect(credentialTransportRefusal(url, {})).toMatchObject({
    code: 'INVALID_ARGS',
    details: { reason: 'insecure_credential_transport' },
  });
});

test('the refusal names the origin and the override, and nothing else from the URL', () => {
  const refusal = credentialTransportRefusal(
    'http://operator:hunter2@fleet.example.test:7777/private?token=secret',
    {},
  );

  expect(refusal?.message).toContain('http://fleet.example.test:7777');
  expect(refusal?.details?.hint).toContain('AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT=1');
  expect(JSON.stringify([refusal?.message, refusal?.details])).not.toMatch(
    /operator|hunter2|private|secret/,
  );
});

test.each([
  ['1', true],
  ['true', false],
  ['0', false],
  [' 1', false],
  ['', false],
])('the override value %j admits plain http: %s', (value, admitted) => {
  const refusal = credentialTransportRefusal('http://10.0.0.7:4310', {
    AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT: value,
  });

  expect(refusal === undefined).toBe(admitted);
});
