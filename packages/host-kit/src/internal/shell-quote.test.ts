import { test } from 'vitest';
import assert from 'node:assert/strict';
import { shellQuote, shellQuoteIfNeeded } from './shell-quote.ts';

test('shellQuote single-quotes and escapes POSIX shell arguments', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote("qa ios; echo 'oops'"), String.raw`'qa ios; echo '\''oops'\'''`);
});

test('shellQuoteIfNeeded keeps safe command arguments readable', () => {
  assert.equal(shellQuoteIfNeeded('default'), 'default');
  assert.equal(shellQuoteIfNeeded('qa-ios_1.2'), 'qa-ios_1.2');
});

test('shellQuoteIfNeeded quotes unsafe command arguments', () => {
  assert.equal(shellQuoteIfNeeded('my session'), "'my session'");
  assert.equal(shellQuoteIfNeeded(''), "''");
  assert.equal(shellQuoteIfNeeded('café'), "'café'");
  assert.equal(shellQuoteIfNeeded("qa ios; echo 'oops'"), String.raw`'qa ios; echo '\''oops'\'''`);
});
