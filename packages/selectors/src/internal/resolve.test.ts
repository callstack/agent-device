import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseSelectorChain } from './parse.ts';
import { findSelectorChainMatch, resolveSelectorChain } from './resolve.ts';
import { loginFormNodes } from './__tests__/login-form-nodes.ts';

test('resolveSelectorChain resolves unique match', () => {
  const chain = parseSelectorChain('id=login_email');
  const resolved = resolveSelectorChain(loginFormNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e1');
});

test('resolveSelectorChain falls back when first selector is ambiguous', () => {
  const chain = parseSelectorChain('label="Continue" || id=auth_continue');
  const resolved = resolveSelectorChain(loginFormNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.selectorIndex, 1);
  assert.equal(resolved.node.ref, 'e2');
});

test('resolveSelectorChain keeps strict ambiguity behavior by default', () => {
  const chain = parseSelectorChain('label="Continue"');
  const resolved = resolveSelectorChain(loginFormNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });
  assert.equal(resolved, null);
});

test('findSelectorChainMatch returns first matching selector for existence checks', () => {
  const chain = parseSelectorChain('label="Continue" || id=auth_continue');
  const match = findSelectorChainMatch(loginFormNodes, chain, {
    platform: 'ios',
  });
  assert.ok(match);
  assert.equal(match.selectorIndex, 0);
  assert.equal(match.matches, 2);
});
