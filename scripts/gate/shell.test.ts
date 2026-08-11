// Segment splitting, kept to the cases where a mistake would OVER-credit a lane or hide
// a command from the no-bypass rule.

import assert from 'node:assert/strict';
import test from 'node:test';
import { commandSegments, stripExpressions } from './shell.ts';

test('a commented-out command in a run: block credits nothing', () => {
  assert.deepEqual(commandSegments('echo done # && pnpm test:unit'), ['echo done']);
  // A `#` inside quotes is data, not a comment.
  assert.deepEqual(commandSegments('echo "a # b" && pnpm x'), ['echo "a # b"', 'pnpm x']);
});

test('every operator that runs a second command splits', () => {
  assert.deepEqual(commandSegments('a && b || c; d | e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(
    commandSegments('pnpm gate lint \\\n  --quiet'),
    ['pnpm gate lint    --quiet'],
    'a continuation joins into ONE segment — inner spacing is normalized by the digest, ' +
      'but a second line must never read as a second command',
  );
});

test('an env prefix stays on the segment, because it is how a step runs code', () => {
  // model.ts strips it to find the script; audit.ts must NOT, or
  // `NODE_OPTIONS=--import ./x.ts pnpm gate lint` reads as a bare gate invocation.
  assert.deepEqual(commandSegments('NODE_OPTIONS=--import ./x.ts pnpm gate lint'), [
    'NODE_OPTIONS=--import ./x.ts pnpm gate lint',
  ]);
});

test('an expression is replaced by a placeholder carrying no shell metacharacters', () => {
  assert.equal(stripExpressions('pnpm gate ${{ matrix.check }}'), 'pnpm gate GITHUB_EXPR');
  assert.deepEqual(
    commandSegments(stripExpressions('pnpm gate x --dest ${{ runner.temp }}/out')),
    ['pnpm gate x --dest GITHUB_EXPR/out'],
    'the placeholder must not introduce a split or a redirection',
  );
});
