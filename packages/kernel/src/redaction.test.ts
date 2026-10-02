import assert from 'node:assert/strict';
import { test } from 'vitest';
import { redactDiagnosticData } from './redaction.ts';

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
