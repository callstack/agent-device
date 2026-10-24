import assert from 'node:assert/strict';
import { test } from 'vitest';
import { redactDiagnosticData, redactNetworkPayload } from './redaction.ts';

test('stderr retains nested command failure details beyond 400 characters', () => {
  const stderr = `Launch request denied\n${'Context line\n'.repeat(50)}Underlying reason: device locked`;
  assert.equal(redactDiagnosticData({ stderr }).stderr, stderr);
});

test('stderr preserves its head and tail within an 8192-character budget', () => {
  const stderr = `Launch request denied\n${'x'.repeat(9000)}\nUnderlying reason: device locked`;
  const result = redactDiagnosticData({ stderr });
  assert.equal(result.stderr.length, 8192);
  assert.ok(result.stderr.startsWith('Launch request denied\n'));
  assert.ok(result.stderr.endsWith('\nUnderlying reason: device locked'));
  assert.match(result.stderr, /<truncated>/);
  assert.deepEqual(redactDiagnosticData(result), result);
});

test('stderr at the budget is preserved without truncation', () => {
  const stderr = 'x'.repeat(8192);
  assert.equal(redactDiagnosticData({ stderr }).stderr, stderr);
});

test('expanded stderr redacts secrets before retaining its head and tail', () => {
  const stderr = [
    'Launch request denied token=head-secret',
    'x'.repeat(500),
    'password=middle-secret',
    'x'.repeat(9000),
    'Underlying reason: bearer tail-secret',
    'https://user:pass@example.com/error?token=query-secret',
  ].join('\n');
  const result = redactDiagnosticData({ nested: { stderr }, apiKey: 'field-secret' });
  assert.equal(result.apiKey, '[REDACTED]');
  assert.ok(result.nested.stderr.startsWith('Launch request denied token=[REDACTED]'));
  assert.ok(result.nested.stderr.includes('Underlying reason: [REDACTED]'));
  assert.ok(result.nested.stderr.endsWith('https://REDACTED:REDACTED@example.com/error?REDACTED'));
  assert.doesNotMatch(result.nested.stderr, /head-secret|middle-secret|tail-secret|query-secret/);
});

test('other diagnostic strings retain the 400-character limit', () => {
  const result = redactDiagnosticData({ message: 'm'.repeat(500), stdout: 'o'.repeat(500) });
  assert.equal(result.message.length, 400);
  assert.equal(result.stdout.length, 400);
  assert.ok(result.message.endsWith('...<truncated>'));
  assert.ok(result.stdout.endsWith('...<truncated>'));
});

test('a network payload keeps its own budget instead of the diagnostic limit', () => {
  const payload = 'p'.repeat(5000);
  // The truncation marker counts against the budget, like the diagnostic bound.
  assert.equal(redactNetworkPayload(payload, 2048).length, 2048);
  assert.ok(redactNetworkPayload(payload, 2048).endsWith('...<truncated>'));
  assert.equal(redactNetworkPayload('p'.repeat(100), 2048), 'p'.repeat(100));
});

test('a network payload masks secrets in each field syntax it can hold', () => {
  assert.equal(
    redactNetworkPayload('{"apiKey":"sk-live-1","user":"bob"}', 2048),
    '{"apiKey":"[REDACTED]","user":"bob"}',
  );
  assert.equal(redactNetworkPayload('token=head-secret', 2048), 'token=[REDACTED]');
  assert.equal(redactNetworkPayload('bearer abc.def', 2048), '[REDACTED]');
  assert.equal(
    redactNetworkPayload('{"token":"adc_agent_..."}', 2048),
    '{"token":"adc_agent_..."}',
  );
  assert.equal(
    redactNetworkPayload("curl --header 'api_key=sk-live-9999'", 2048),
    "curl --header 'api_key=[REDACTED]",
  );
  assert.equal(
    redactNetworkPayload(String.raw`{"apiKey":"ab\"cd-secret"}`, 2048),
    '{"apiKey":"[REDACTED]"}',
  );
});

test('a network payload truncation stays inside its budget', () => {
  const redacted = redactNetworkPayload(`${'x'.repeat(3000)}token=abc123secret`, 2048);
  assert.equal(redacted.length, 2048);
  assert.ok(redacted.includes('truncated'));
});

test('a header with a sensitive name is replaced and its peers keep their text', () => {
  assert.deepEqual(
    redactDiagnosticData({ authorization: 'Bearer abc123', 'x-request-id': 'r-1' }),
    {
      authorization: '[REDACTED]',
      'x-request-id': 'r-1',
    },
  );
});
