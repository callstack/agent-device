import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { GesturePlan, InteractionGuarantee } from '@agent-device/contracts/interaction';
import { makeSnapshotState } from '../../../src/__tests__/test-utils/index.ts';
import { scenarioName } from './coverage-manifest.ts';
import { assertRpcOk } from '../provider-scenarios/assertions.ts';
import { PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS } from '../provider-scenarios/test-timeouts.ts';
import { TARGET_DRAG_COVERAGE } from './target-drag.coverage.ts';
import { coveredButtonSnapshot, dragEndpointsSnapshot } from './fixtures.ts';
import { createContractDevice } from './runtime-harness.ts';
import {
  runnerGestureEntry,
  runnerGestureViewportEntry,
  runnerSnapshotEntry,
  withIosContractDaemon,
} from './daemon-harness.ts';

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(TARGET_DRAG_COVERAGE, guarantee);

test(scenario('disambiguation'), async () => {
  const plans: GesturePlan[] = [];
  const device = createContractDevice(dragEndpointsSnapshot(), {
    resolveGestureViewport: async () => ({ x: 0, y: 0, width: 400, height: 800 }),
    performGesture: async (_context, plan) => {
      plans.push(plan);
    },
  });

  const result = await device.interactions.gesture({
    session: 'default',
    gesture: {
      intent: 'drag',
      source: 'id="source"',
      destination: 'label="Drop"',
      sourceHoldMs: 800,
      moveMs: 500,
    },
  });

  assert.equal(plans.length, 1);
  assert.equal(result.kind, 'drag');
  if (result.kind !== 'drag') return;
  assert.deepEqual(result.from, { x: 70, y: 130 });
  assert.deepEqual(result.to, { x: 300, y: 540 });
  assert.match(result.targets.source.selectorChain?.[0] ?? '', /id="source"/);
  assert.match(result.targets.destination.selectorChain?.[0] ?? '', /id="destination"/);
  assert.equal(result.targets.source.resolution.kind, 'unique');
  assert.equal(result.targets.destination.resolution.kind, 'disambiguated');
});

test(scenario('occlusion'), async () => {
  let dispatches = 0;
  const source = dragEndpointsSnapshot().nodes[1]!;
  const snapshot = makeSnapshotState([source, ...coveredButtonSnapshot().nodes]);
  const device = createContractDevice(snapshot, {
    resolveGestureViewport: async () => ({ x: 0, y: 0, width: 400, height: 800 }),
    performGesture: async () => {
      dispatches += 1;
    },
  });
  await assert.rejects(
    () =>
      device.interactions.gesture({
        session: 'default',
        gesture: {
          intent: 'drag',
          source: 'id="source"',
          destination: 'label="Save draft"',
        },
      }),
    /covered by another visible element/,
  );
  assert.equal(dispatches, 0);
});

test(scenario('offscreen'), async () => {
  let dispatches = 0;
  const snapshot = dragEndpointsSnapshot();
  snapshot.nodes[1] = { ...snapshot.nodes[1]!, rect: { x: -200, y: 100, width: 100, height: 60 } };
  const device = createContractDevice(snapshot, {
    resolveGestureViewport: async () => ({ x: 0, y: 0, width: 400, height: 800 }),
    performGesture: async () => {
      dispatches += 1;
    },
  });
  await assert.rejects(
    () =>
      device.interactions.gesture({
        session: 'default',
        gesture: { intent: 'drag', source: 'id="source"', destination: 'id="destination"' },
      }),
    /off-screen/,
  );
  assert.equal(dispatches, 0);
});

test(scenario('errorTaxonomy'), async () => {
  const device = createContractDevice(dragEndpointsSnapshot(), {
    resolveGestureViewport: async () => ({ x: 0, y: 0, width: 400, height: 800 }),
    performGesture: async () => {},
  });
  await assert.rejects(
    () =>
      device.interactions.gesture({
        session: 'default',
        gesture: { intent: 'drag', source: 'id="source"', destination: 'id="missing"' },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match(error.message, /Selector did not match/);
      return true;
    },
  );
});

test(
  scenario('responseConstruction'),
  async () => {
    const nodes = dragEndpointsSnapshot().nodes;
    await withIosContractDaemon(
      [
        runnerGestureViewportEntry(),
        runnerSnapshotEntry(nodes),
        runnerSnapshotEntry(nodes),
        runnerGestureEntry({ synthesized: true }),
      ],
      async (daemon) => {
        const data = assertRpcOk(
          await daemon.callCommand(
            'gesture',
            ['drag', 'id="source"', 'id="destination"', '800', '500', '0'],
            {},
            {
              input: {
                kind: 'drag',
                source: 'id="source"',
                destination: 'id="destination"',
                sourceHoldMs: 800,
                moveMs: 500,
                destinationHoldMs: 0,
              },
            },
          ),
        );
        assert.equal(data.kind, 'drag');
        assert.equal(data.pointerCount, 1);
        assert.equal(data.durationMs, 1_300);
        assert.deepEqual(data.timing, {
          executionProfile: 'timed-pan',
          gestureDurationMs: 1_300,
        });
        assert.ok(data.targets);
        assert.equal(data.synthesized, true);
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);
