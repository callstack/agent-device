import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ref, selector } from './selector-read-utils.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  createInteractionDevice,
  dragTargetSnapshot,
  selectorSnapshot,
} from './__tests__/test-utils/index.ts';

test('runtime focus and longPress share selector/ref target resolution', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    focus: async (_context, point) => {
      calls.push({ command: 'focus', point });
      return { focused: true };
    },
    longPress: async (_context, point, options) => {
      calls.push({ command: 'longPress', point, durationMs: options?.durationMs });
    },
  });

  const focused = await device.interactions.focus(selector('label=Continue'), {
    session: 'default',
  });
  const longPressed = await device.interactions.longPress(ref('@e1'), {
    session: 'default',
    durationMs: 750,
  });

  assert.equal(focused.kind, 'selector');
  assert.deepEqual(focused.backendResult, { focused: true });
  assert.equal(longPressed.kind, 'ref');
  assert.deepEqual(calls, [
    { command: 'focus', point: { x: 60, y: 40 } },
    { command: 'longPress', point: { x: 60, y: 40 }, durationMs: 750 },
  ]);
});

test('runtime drag resolves generic selector endpoints before one continuous pointer plan', async () => {
  let capturedPlan:
    | Parameters<NonNullable<import('../../../backend.ts').AgentDeviceBackend['performGesture']>>[1]
    | undefined;
  const snapshot = dragTargetSnapshot();
  const device = createInteractionDevice(snapshot, {
    resolveGestureViewport: async () => ({ x: 0, y: 0, width: 400, height: 800 }),
    performGesture: async (_context, plan) => {
      capturedPlan = plan;
    },
  });

  const result = await device.interactions.gesture({
    gesture: {
      intent: 'drag',
      source: 'id="drag-source"',
      destination: '@e3',
      sourceHoldMs: 700,
      moveMs: 600,
      destinationHoldMs: 200,
    },
  });

  assert.equal(result.kind, 'drag');
  assert.equal(result.durationMs, 1_500);
  assert.deepEqual(result.from, { x: 80, y: 130 });
  assert.deepEqual(result.to, { x: 290, y: 440 });
  assert.equal(capturedPlan?.topology, 'single');
  assert.deepEqual(capturedPlan?.pointers[0]?.samples[1], {
    offsetMs: 700,
    point: { x: 80, y: 130 },
  });
  assert.deepEqual(capturedPlan?.pointers[0]?.samples.at(-1), {
    offsetMs: 1_500,
    point: { x: 290, y: 440 },
  });
  assert.equal(result.recording?.sourceSelector?.split(' || ')[0], 'id="drag-source"');
  assert.equal(result.recording?.destinationSelector?.split(' || ')[0], 'id="drop-target"');
  assert.deepEqual(result.targets?.source.resolution, {
    source: 'runtime',
    phase: 'pre-action',
    kind: 'unique',
  });
  assert.deepEqual(result.targets?.destination.resolution, {
    source: 'ref',
    phase: 'pre-action',
    kind: 'exact',
  });
  assert.equal(result.targets?.source.selectorChain?.[0], 'id="drag-source"');
  assert.equal(result.targets?.destination.selectorChain?.[0], 'id="drop-target"');
});

test('runtime drag resolves both endpoints before dispatching any device gesture', async () => {
  let dispatchCount = 0;
  const device = createInteractionDevice(dragTargetSnapshot(), {
    resolveGestureViewport: async () => ({ x: 0, y: 0, width: 400, height: 800 }),
    performGesture: async () => {
      dispatchCount += 1;
    },
  });

  await assert.rejects(
    () =>
      device.interactions.gesture({
        gesture: {
          intent: 'drag',
          source: 'id="drag-source"',
          destination: 'id="missing-target"',
        },
      }),
    (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
  );
  assert.equal(dispatchCount, 0);
});

test('runtime drag identifies a destination post-resolution guard mismatch before dispatch', async () => {
  let dispatchCount = 0;
  const device = createInteractionDevice(dragTargetSnapshot(), {
    resolveGestureViewport: async () => ({ x: 0, y: 0, width: 400, height: 800 }),
    performGesture: async () => {
      dispatchCount += 1;
    },
  });

  await assert.rejects(
    () =>
      device.interactions.gesture({
        gesture: {
          intent: 'drag',
          source: 'id="drag-source"',
          destination: 'id="drop-target"',
        },
        expectedResolvedTargets: {
          source: {
            identity: { id: 'drag-source', role: 'view', label: 'Drag source' },
            structural: { documentOrder: 1, sibling: 0 },
          },
          destination: {
            identity: { id: 'different-target', role: 'view', label: 'Drop target' },
            structural: { documentOrder: 2, sibling: 1 },
          },
        },
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'replay_target_guard_mismatch' &&
      error.details?.targetRole === 'destination',
  );
  assert.equal(dispatchCount, 0);
});

test('runtime longPress with settle drops the non-hittable hint when the diff proves a change', async () => {
  let captureCount = 0;
  const nonHittableSnapshot = selectorSnapshot();
  const nonHittableNode = nonHittableSnapshot.nodes[0];
  assert.ok(nonHittableNode);
  nonHittableSnapshot.nodes[0] = {
    ...nonHittableNode,
    hittable: false,
  };
  const changedSnapshot = selectorSnapshot();
  const changedNode = changedSnapshot.nodes[0];
  assert.ok(changedNode);
  changedSnapshot.nodes[0] = {
    ...changedNode,
    label: 'Context menu',
    value: undefined,
    hittable: true,
  };
  const device = createInteractionDevice(nonHittableSnapshot, {
    captureSnapshot: async () => {
      captureCount += 1;
      return { snapshot: captureCount === 1 ? nonHittableSnapshot : changedSnapshot };
    },
    longPress: async () => ({ ok: true }),
  });

  const result = await device.interactions.longPress(selector('label=Continue'), {
    session: 'default',
    settle: { quietMs: 25, timeoutMs: 2_000 },
  });

  assert.equal(result.kind, 'selector');
  if (result.kind !== 'selector') return;
  assert.equal(result.targetHittable, false);
  assert.deepEqual(result.settle?.diff?.summary, { additions: 1, removals: 1, unchanged: 0 });
  assert.equal('hint' in result, false);
});

test('runtime multi-touch planning prefers backend viewport geometry without a snapshot capture', async () => {
  let capturedPlan: unknown;
  const device = createInteractionDevice(selectorSnapshot(), {
    platform: 'android',
    captureSnapshot: async () => {
      throw new Error('gesture viewport must not capture Android accessibility state');
    },
    resolveGestureViewport: async () => ({ x: 0, y: 0, width: 300, height: 600 }),
    performGesture: async (_context, plan) => {
      capturedPlan = plan;
    },
  });

  await device.interactions.gesture({
    gesture: {
      intent: 'pan',
      origin: { x: 150, y: 300 },
      delta: { x: 20, y: 0 },
      pointerCount: 2,
    },
  });

  assert.deepEqual(
    capturedPlan && typeof capturedPlan === 'object' && 'viewport' in capturedPlan
      ? capturedPlan.viewport
      : undefined,
    { x: 0, y: 0, width: 300, height: 600 },
  );
});
