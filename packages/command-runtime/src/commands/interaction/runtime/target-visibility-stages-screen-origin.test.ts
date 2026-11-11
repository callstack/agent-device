import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { IosViewportEvidence } from '@agent-device/contracts/ios-snapshot';
import type { Point, RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { attachSnapshotViewportEvidence } from '@agent-device/contracts/capture';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { createIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-acquisition';
import { presentIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-runtime';
import { snapshotViewportSizeFrom } from '@agent-device/kernel/rect';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';
import { ref, selector } from './selector-read-utils.ts';

function geometrySnapshot(kind: IosViewportEvidence['kind']) {
  const screenRoot = { x: 241, y: 224, width: 551, height: 813 };
  const root = kind === 'reported' ? screenRoot : { ...screenRoot, x: 0, y: 0 };
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Application', rect: root },
    { index: 1, depth: 1, parentIndex: 0, type: 'Group', rect: root, hittable: false },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      identifier: 'geometry-action',
      label: 'Geometry action',
      rect: { x: root.x + 240, y: root.y + 90, width: 220, height: 42 },
      hittable: true,
    },
  ];
  attachSnapshotViewportEvidence(
    nodes,
    kind === 'missing' ? { kind, reason: 'not-provided' } : { kind, rect: root },
  );
  return buildSnapshotState(
    {
      nodes,
      backend: 'xctest',
      producer: 'apple-runner',
      // A plausible stored/public viewport cannot upgrade this capture's explicit uncertainty.
      viewport: snapshotViewportSizeFrom(screenRoot),
    },
    undefined,
  );
}

function originRefusal(error: unknown): boolean {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.reason, 'window-origin-unknown');
  assert.equal(error.details?.dispatched, 'no');
  return true;
}

for (const kind of ['reported', 'derived', 'missing'] as const) {
  for (const route of ['selector', 'ref', 'native-ref'] as const) {
    test(`provider ${route} preserves ${kind} authority through presentation and memory-session cloning`, async () => {
      const root = {
        x: kind === 'reported' ? 241 : 0,
        y: kind === 'reported' ? 224 : 0,
        width: 551,
        height: 813,
      };
      const acquired = createIosSnapshotAcquisition({
        producer: 'appium-source',
        viewport: kind === 'missing' ? { kind, reason: 'not-provided' } : { kind, rect: root },
        lineage: { targetId: 'provider-ios' },
        nodes: [
          { index: 0, depth: 0, type: 'Application', rect: root },
          { index: 1, depth: 1, parentIndex: 0, type: 'Group', rect: root },
          {
            index: 2,
            depth: 2,
            parentIndex: 1,
            type: 'Button',
            identifier: 'geometry-action',
            label: 'Geometry action',
            rect: { x: root.x + 240, y: root.y + 90, width: 220, height: 42 },
            hittable: true,
          },
        ],
      });
      const presented = presentIosSnapshotAcquisition(
        acquired,
        kind === 'missing' ? { raw: true } : undefined,
      );
      const calls: unknown[] = [];
      const device = createInteractionDevice(buildSnapshotState(presented, undefined), {
        tap: async (_context, point) => {
          calls.push(point);
        },
        tapTarget:
          route === 'native-ref'
            ? async (_context, target) => {
                calls.push(target);
              }
            : undefined,
      });
      const observed = await device.capture.snapshot({ session: 'default' });
      const target = observed.nodes.find((node) => node.identifier === 'geometry-action');
      assert.ok(target?.ref);
      const actionTarget =
        route === 'selector' ? selector('id=geometry-action') : ref(`@${target.ref}`);
      const failure = await device.interactions.click(actionTarget, { session: 'default' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (kind === 'reported') {
        assert.equal(failure, undefined);
        assert.deepEqual(calls, [
          route === 'native-ref' ? { kind: 'ref', ref: `@${target.ref}` } : { x: 591, y: 335 },
        ]);
        assert.deepEqual(presented.viewport, { width: 551, height: 813 });
      } else {
        assert.deepEqual(calls, []);
        originRefusal(failure);
        assert.equal(presented.viewport, undefined);
      }
    });
  }
}

for (const kind of ['derived', 'missing'] as const) {
  for (const route of ['selector', 'ref', 'native-ref'] as const) {
    test(`${route} refuses ${kind} screen authority after compaction and memory-session cloning`, async () => {
      const calls: unknown[] = [];
      const snapshot = geometrySnapshot(kind);
      const device = createInteractionDevice(snapshot, {
        tap: async (_context, point) => {
          calls.push(point);
        },
        tapTarget:
          route === 'native-ref'
            ? async (_context, target) => {
                calls.push(target);
              }
            : undefined,
        confirmOffscreenTargetVisible: async () => {
          calls.push('visibility rescue');
          return { x: 481, y: 314, width: 220, height: 42 };
        },
      });
      // This command writes through createMemorySessionStore.set; the ref action reads its clone.
      const observed = await device.capture.snapshot({ session: 'default' });
      const target = observed.nodes.find((node) => node.identifier === 'geometry-action');
      assert.ok(target?.ref);
      const actionTarget =
        route === 'selector' ? selector('id=geometry-action') : ref(`@${target.ref}`);
      const failure = await device.interactions.click(actionTarget, { session: 'default' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.deepEqual(calls, []);
      originRefusal(failure);
    });
  }
}

test('reported screen geometry still activates the resolved selector and saved ref', async () => {
  const taps: Point[] = [];
  const device = createInteractionDevice(geometrySnapshot('reported'), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });
  const observed = await device.capture.snapshot({ session: 'default' });
  const target = observed.nodes.find((node) => node.identifier === 'geometry-action');
  assert.ok(target?.ref);
  await device.interactions.press(selector('id=geometry-action'), { session: 'default' });
  await device.interactions.press(ref(`@${target.ref}`), { session: 'default' });
  assert.deepEqual(taps, [
    { x: 591, y: 335 },
    { x: 591, y: 335 },
  ]);
});

test('unknown capture authority refuses before an offscreen rescue can replace geometry', async () => {
  const snapshot = geometrySnapshot('derived');
  const target = snapshot.nodes.find((node) => node.identifier === 'geometry-action');
  assert.ok(target?.rect);
  target.rect = { ...target.rect, y: -100 };
  const calls: string[] = [];
  const device = createInteractionDevice(snapshot, {
    tap: async () => {
      calls.push('tap');
    },
    confirmOffscreenTargetVisible: async () => {
      calls.push('rescue');
      return { x: 481, y: 314, width: 220, height: 42 };
    },
  });
  const failure = await device.interactions
    .press(selector('id=geometry-action'), { session: 'default' })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.deepEqual(calls, []);
  originRefusal(failure);
});

test('snapshot-derived gesture bounds refuse unknown origin before input', async () => {
  const calls: string[] = [];
  const device = createInteractionDevice(geometrySnapshot('derived'), {
    performGesture: async () => {
      calls.push('gesture');
    },
  });
  // The local point fits the inferred box, so only screen authority can stop unsafe input.
  const failure = await device.interactions
    .gesture({
      gesture: { intent: 'pan', origin: { x: 350, y: 111 }, delta: { x: 10, y: 0 } },
      session: 'default',
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.deepEqual(calls, []);
  originRefusal(failure);
});

test('authored screen points and independently measured native gesture bounds remain usable', async () => {
  const calls: string[] = [];
  const device = createInteractionDevice(geometrySnapshot('derived'), {
    tap: async () => {
      calls.push('tap');
    },
    resolveGestureViewport: async () => ({ x: 0, y: 0, width: 1032, height: 1376 }),
    performGesture: async () => {
      calls.push('gesture');
    },
  });
  await device.interactions.press({ kind: 'point', x: 591, y: 335 }, { session: 'default' });
  await device.interactions.gesture({
    gesture: { intent: 'pan', origin: { x: 591, y: 335 }, delta: { x: 10, y: 0 } },
    session: 'default',
  });
  assert.deepEqual(calls, ['tap', 'gesture']);
});
