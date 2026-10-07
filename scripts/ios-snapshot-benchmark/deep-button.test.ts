import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assertInvalidShallowRuleFails,
  assertSafeFullRulePasses,
  readDeepButtonFixtureArtifact,
} from './deep-button.ts';

test('the checked-in fixture has a real 72-level ancestor chain', () => {
  const artifact = readDeepButtonFixtureArtifact();
  assert.equal(artifact.depth, 72);
  assert.equal(artifact.nodes.length, 73);
  assert.equal(artifact.before.changedNode.depth, 72);
  assert.equal(artifact.after.changedNode.depth, 72);
  assert.notDeepEqual(artifact.before.changedNode, artifact.after.changedNode);
});

test('the planted invalid rule is red and the full rule is green', () => {
  assert.throws(assertInvalidShallowRuleFails, /changed descendant was omitted/);
  assert.doesNotThrow(assertSafeFullRulePasses);
});
