import assert from 'node:assert/strict';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { test } from 'vitest';
import {
  describeCoverage,
  expectationViolation,
  IOS_SUITE,
  IOS_SUITE_EXCLUSIONS,
} from './ios-suite.ts';

test('every public command is either measured by the iOS suite or excluded with a reason', () => {
  const { measured, excluded } = describeCoverage(IOS_SUITE, IOS_SUITE_EXCLUSIONS);
  const classified = [...measured, ...excluded.map((e) => e.command)].sort();
  assert.deepEqual(classified, Object.values(PUBLIC_COMMANDS).sort());
  for (const { reason } of excluded) assert.ok(reason.length > 0);
});

test('step ids are unique, so comparisons key each step once', () => {
  const ids = IOS_SUITE.flatMap((scenario) => scenario.steps.map((s) => `${scenario.id}/${s.id}`));
  assert.equal(new Set(ids).size, ids.length);
});

test('a heavy-feed capture breaks its expectation when the tree flattens or the tree backend copes', () => {
  const depth = { maxDepthAtLeast: 64 };
  assert.equal(expectationViolation(depth, { maxDepth: 64 }), undefined);
  assert.match(expectationViolation(depth, { maxDepth: 63 })!, /below 64/);
  assert.match(expectationViolation(depth, undefined)!, /unknown/);

  const degraded = { treeBackendDegraded: true };
  assert.equal(
    expectationViolation(degraded, { backend: 'private-ax', state: 'recovered' }),
    undefined,
  );
  assert.equal(expectationViolation(degraded, { backend: 'tree', state: 'sparse' }), undefined);
  assert.match(
    expectationViolation(degraded, { backend: 'tree', state: 'healthy' })!,
    /non-sparse/,
  );
});
