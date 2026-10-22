import assert from 'node:assert/strict';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { test } from 'vitest';
import {
  describeCoverage,
  expectationViolation,
  SUITE,
  SUITE_EXCLUSIONS,
  suiteFor,
  type SuiteScenario,
  type SuiteStep,
} from './suite.ts';
import type { Platform } from './types.ts';

const PLATFORMS: readonly Platform[] = ['ios', 'android'];

test('on each platform, every public command is either measured or excluded with a reason', () => {
  for (const platform of PLATFORMS) {
    const { measured, excluded } = describeCoverage(suiteFor(platform), SUITE_EXCLUSIONS[platform]);
    const classified = [...measured, ...excluded.map((e) => e.command)].sort();
    assert.deepEqual(classified, Object.values(PUBLIC_COMMANDS).sort(), platform);
    for (const { reason } of excluded) assert.ok(reason.length > 0);
  }
});

test('step ids are unique per platform, so comparisons key each step once', () => {
  for (const platform of PLATFORMS) {
    const ids = suiteFor(platform).flatMap((scenario) =>
      scenario.steps.map((s) => `${scenario.id}/${s.id}`),
    );
    assert.equal(new Set(ids).size, ids.length, platform);
  }
});

test('a platform suite drops the other platform steps and applies its own deltas', () => {
  const shared = { id: 'swipe', command: PUBLIC_COMMANDS.swipe, args: ['swipe', '1'] };
  const suite: SuiteScenario<SuiteStep>[] = [
    {
      id: 'scenario',
      title: 'scenario',
      setup: [],
      steps: [
        { ...shared, on: { android: { args: ['swipe', '2'], before: [] } }, before: [['wait']] },
        { id: 'ios-only', command: PUBLIC_COMMANDS.actionButton, args: [], only: 'ios' },
      ],
    },
  ];
  assert.deepEqual(suiteFor('ios', suite)[0]!.steps, [
    { ...shared, before: [['wait']] },
    { id: 'ios-only', command: PUBLIC_COMMANDS.actionButton, args: [] },
  ]);
  assert.deepEqual(suiteFor('android', suite)[0]!.steps, [
    { ...shared, args: ['swipe', '2'], before: [] },
  ]);
});

test('every platform runs at least one step of every scenario', () => {
  for (const scenario of SUITE) {
    for (const platform of PLATFORMS) {
      const resolved = suiteFor(platform).find((s) => s.id === scenario.id);
      assert.ok(resolved && resolved.steps.length > 0, `${platform} ${scenario.id}`);
    }
  }
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

test('an Android capture breaks its expectation when another helper transport served it', () => {
  const oneShot = { transport: 'instrumentation' };
  assert.equal(expectationViolation(oneShot, { transport: 'instrumentation' }), undefined);
  assert.match(
    expectationViolation(oneShot, { transport: 'persistent-session' })!,
    /persistent-session transport served the capture, not instrumentation/,
  );
  assert.match(expectationViolation(oneShot, {})!, /unknown transport/);
});
