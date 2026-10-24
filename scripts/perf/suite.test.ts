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

test('a heavy-feed capture breaks its expectation when the tree flattens', () => {
  const depth = { maxDepthAtLeast: 64 };
  assert.equal(expectationViolation(depth, { maxDepth: 64 }), undefined);
  assert.match(expectationViolation(depth, { maxDepth: 63 })!, /below 64/);
  assert.match(expectationViolation(depth, undefined)!, /unknown/);
});

test('a pinned capture breaks its expectation unless the pinned backend served it', () => {
  const pinned = { pinnedBackend: 'tree' } as const;
  const served = { backend: 'tree', state: 'healthy', reasonCode: 'requested-backend' };
  assert.equal(expectationViolation(pinned, served), undefined);
  // The raw plan ignores the pin and recovers through private AX on the heavy feed.
  assert.match(
    expectationViolation(pinned, {
      backend: 'private-ax',
      state: 'recovered',
      reasonCode: 'ax-rejected',
    })!,
    /private-ax backend \(ax-rejected\)/,
  );
  // An unpinned capture can still be tree-first on a light screen.
  assert.match(
    expectationViolation(pinned, { backend: 'tree', state: 'healthy' })!,
    /no reason code/,
  );
  assert.match(expectationViolation(pinned, undefined)!, /unknown backend/);
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

test('the Android heavy-feed raw capture expects the persistent session to answer', () => {
  const heavyFeed = suiteFor('android').find((s) => s.id === 'heavy-feed')!;
  const raw = heavyFeed.steps.find((s) => s.id === 'snapshot-raw')!;
  assert.match(
    expectationViolation(raw.expect, { maxDepth: 60, transport: 'instrumentation' })!,
    /instrumentation transport served the capture, not persistent-session/,
  );
  assert.equal(
    expectationViolation(raw.expect, { maxDepth: 60, transport: 'persistent-session' }),
    undefined,
  );
  const iosRaw = suiteFor('ios')
    .find((s) => s.id === 'heavy-feed')!
    .steps.find((s) => s.id === 'snapshot-raw')!;
  assert.equal(iosRaw.expect?.transport, undefined);
});
