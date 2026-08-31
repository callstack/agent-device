import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assertInvalidShallowRuleFails,
  assertSafeFullRulePasses,
  deepButtonFixtureEvidence,
} from './deep-button.ts';

test('the shallow control observes no change while the full tree changes', () => {
  const evidence = deepButtonFixtureEvidence();
  assert.equal(evidence.before.surfaceDigest, evidence.after.surfaceDigest);
  assert.notEqual(evidence.before.fullDigest, evidence.after.fullDigest);
  assert.ok(!evidence.after.surfaceNodeIds.includes(evidence.changedDescendant));
  assert.ok(evidence.after.fullNodeIds.includes(evidence.changedDescendant));
});

test('the planted invalid rule is red and the full rule is green', () => {
  assert.throws(assertInvalidShallowRuleFails, /changed descendant was omitted/);
  assert.doesNotThrow(assertSafeFullRulePasses);
});
