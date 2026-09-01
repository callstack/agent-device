import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assertInvalidShallowRuleFails,
  assertSafeFullRulePasses,
  deepButtonFixtureEvidence,
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

test('the shallow control observes no change while the full tree changes', () => {
  const evidence = deepButtonFixtureEvidence();
  assert.equal(evidence.artifact, 'deep-button-fixture.v1.json');
  assert.equal(evidence.depth, 72);
  assert.equal(evidence.before.surfaceDigest, evidence.after.surfaceDigest);
  assert.notEqual(evidence.before.fullDigest, evidence.after.fullDigest);
  assert.ok(!evidence.after.surfaceNodeIds.includes(evidence.changedDescendant));
  assert.ok(evidence.after.fullNodeIds.includes(evidence.changedDescendant));
});

test('the planted invalid rule is red and the full rule is green', () => {
  assert.throws(assertInvalidShallowRuleFails, /changed descendant was omitted/);
  assert.doesNotThrow(assertSafeFullRulePasses);
});
