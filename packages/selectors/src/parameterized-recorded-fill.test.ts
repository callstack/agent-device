import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parameterizeSensitiveString } from './parameterized-recorded-fill.ts';

test('a value that contains the placeholder collapses the whole string', () => {
  assert.equal(
    parameterizeSensitiveString(
      'could not type "abc[REDACTED]xyz"',
      'abc[REDACTED]xyz',
      '[REDACTED]',
    ),
    '[REDACTED]',
  );
  assert.equal(
    parameterizeSensitiveString(
      'could not type "abc${PASSWORD}xyz"',
      'abc${PASSWORD}xyz',
      '${PASSWORD}',
    ),
    '${PASSWORD}',
  );
});

test('a value that crosses a placeholder already in the string collapses the whole string', () => {
  // `D]tail` starts inside the earlier `[REDACTED]` and ends after it, so no segment holds it.
  assert.equal(
    parameterizeSensitiveString('typed [REDACTED]tail', 'D]tail', '[REDACTED]'),
    '[REDACTED]',
  );
});

test('a value found only inside placeholders leaves the string as it is', () => {
  assert.equal(
    parameterizeSensitiveString('value ${DOLLAR} kept', '$', '${DOLLAR}'),
    'value ${DOLLAR} kept',
  );
  assert.equal(
    parameterizeSensitiveString('typed ${PASSWORD}', 'PASSWORD', '${PASSWORD}'),
    'typed ${PASSWORD}',
  );
});

test('an ordinary value is replaced in place and a second pass changes nothing', () => {
  const once = parameterizeSensitiveString(
    'could not type "s3cret" twice: s3cret',
    's3cret',
    '[REDACTED]',
  );
  assert.equal(once, 'could not type "[REDACTED]" twice: [REDACTED]');
  assert.equal(parameterizeSensitiveString(once, 's3cret', '[REDACTED]'), once);
});
