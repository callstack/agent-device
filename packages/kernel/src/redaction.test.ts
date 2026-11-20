import assert from 'node:assert/strict';
import { test } from 'vitest';
import { escapeTerminalText, redactDiagnosticData, redactSecretLikeText } from './redaction.ts';

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

test('a diamond chain redacts each shared node once, not once per path', () => {
  // 40 levels where both keys of a level point at the next one: 2^40 paths to the leaf.
  let reads = 0;
  const leaf = new Proxy(
    { token: 'leaf-secret', note: 'leaf' },
    {
      ownKeys(target) {
        reads += 1;
        return Reflect.ownKeys(target);
      },
    },
  );
  let counted: Record<string, unknown> = leaf;
  for (let depth = 0; depth < 40; depth += 1) counted = { left: counted, right: counted };

  const result = redactDiagnosticData({ root: counted }) as { root: Record<string, unknown> };
  let node = result.root;
  for (let depth = 0; depth < 40; depth += 1) {
    assert.equal(node.left, node.right);
    node = node.left as Record<string, unknown>;
  }
  assert.deepEqual(node, { token: '[REDACTED]', note: 'leaf' });
  assert.equal(reads, 1);
});

// --- display-line scrub of secret-like tokens (INVALID_ARGS argv echoes) ---

test.each([
  [
    'a password typed as an extra positional keeps only its length',
    'fill accepts at most 2 positional argument(s), received 3: @e1 Sup3rSecretPass!2026 extra',
    'fill accepts at most 2 positional argument(s), received 3: @e1 <redacted len=20> extra',
  ],
  [
    'a quoted password is replaced with its whole token, quotes included',
    'Unknown command: "Sup3rSecretPass!2026"',
    'Unknown command: <redacted len=22>',
  ],
  [
    'a mixed-case token with an inner symbol but no digit is a secret too',
    'Flag --token requires a value: SuperSecret_Pass!',
    'Flag --token requires a value: <redacted len=17>',
  ],
  [
    'a short credential-shaped token stays below the length bar',
    'Invalid password: P4ss!word',
    'Invalid password: P4ss!word',
  ],
  [
    'a lowercase path or app id keeps its text',
    'push /data/local/tmp/myapp.apk onto com.example.app',
    'push /data/local/tmp/myapp.apk onto com.example.app',
  ],
  [
    'an uppercase-and-digit token without lowercase keeps its text',
    'received 1: A1B2C3D4E5F6G7H8',
    'received 1: A1B2C3D4E5F6G7H8',
  ],
  [
    'an instruction identifier with sentence punctuation keeps its text',
    'target is not accepted as a tool argument. Pass deviceTarget.',
    'target is not accepted as a tool argument. Pass deviceTarget.',
  ],
  [
    'a path with a capitalized segment reads as mixed case and is redacted: the rule is conservative',
    'pull /storage/emulated/0/Download/recording-2026.m4a',
    'pull <redacted len=47>',
  ],
  [
    'ordinary short arguments display unchanged',
    'press accepts at most 2 positional argument(s), received 3: @e1 hello world',
    'press accepts at most 2 positional argument(s), received 3: @e1 hello world',
  ],
])('redactSecretLikeText: %s', (_name, input, expected) => {
  assert.equal(redactSecretLikeText(input), expected);
});

test('redactSecretLikeText keeps whitespace and untouched tokens in place', () => {
  assert.equal(redactSecretLikeText('a  b\tSup3rSecretPass!2026\nc'), 'a  b\t<redacted len=20>\nc');
});

test('redactSecretLikeText output passes the terminal escape unchanged and round trips through JSON', () => {
  const scrubbed = redactSecretLikeText('received 3: @e1 Sup3rSecretPass!2026 extra');
  assert.equal(escapeTerminalText(scrubbed), scrubbed);
  assert.equal(JSON.parse(JSON.stringify({ message: scrubbed })).message, scrubbed);
});
