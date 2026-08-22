import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseSelectorChain } from './parse.ts';
import {
  findSelectorChainMatch,
  resolveSelectorChain,
  resolveSelectorChainDomain,
} from './resolve.ts';
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

test("resolveSelectorChainDomain reports the winning alternative's matched nodes", () => {
  const chain = parseSelectorChain('label="Continue" || id=auth_continue');
  const domain = resolveSelectorChainDomain(loginFormNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });
  // The winner comes from the SECOND alternative, so its domain must be that
  // alternative's single match — not the first alternative's two "Continue"s.
  assert.equal(domain.resolution?.selectorIndex, 1);
  assert.deepEqual(
    domain.matchedNodes.map((node) => node.ref),
    ['e2'],
  );
});

test('resolveSelectorChainDomain reports the first matching alternative when nothing resolves', () => {
  const domain = resolveSelectorChainDomain(
    loginFormNodes,
    parseSelectorChain('label="Continue"'),
    {
      platform: 'ios',
      requireRect: true,
      requireUnique: true,
    },
  );
  assert.equal(domain.resolution, null);
  assert.deepEqual(
    domain.matchedNodes.map((node) => node.ref),
    ['e2', 'e3'],
  );

  const missing = resolveSelectorChainDomain(loginFormNodes, parseSelectorChain('id=absent'), {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });
  assert.deepEqual(missing, { resolution: null, matchedNodes: [] });
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
