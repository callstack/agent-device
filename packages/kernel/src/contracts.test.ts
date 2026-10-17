import assert from 'node:assert/strict';
import { test } from 'vitest';
import { namesSessionExplicitly } from './contracts.ts';

test('a client that set the explicit-session meta names its session', () => {
  assert.equal(namesSessionExplicitly({ meta: { sessionExplicit: true } }), true);
});

test('a non-blank session flag names a session as firmly as the client meta does', () => {
  assert.equal(namesSessionExplicitly({ flags: { session: 'e2e-ios-0' } }), true);
});

test('a blank session flag and an unset meta name no session', () => {
  for (const session of ['', '   ']) {
    assert.equal(namesSessionExplicitly({ flags: { session } }), false);
  }
  assert.equal(namesSessionExplicitly({}), false);
  assert.equal(namesSessionExplicitly({ meta: { sessionExplicit: false } }), false);
});
