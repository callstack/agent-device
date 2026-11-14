import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import { buildScrollGesturePlan } from '@agent-device/contracts/scroll-gesture';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Rect } from '@agent-device/kernel/snapshot';

const { runHarmonyShell, sleep, readHarmonyGestureViewport, invalidateHarmonyGestureViewport } =
  vi.hoisted(() => ({
    runHarmonyShell: vi.fn(),
    sleep: vi.fn(),
    readHarmonyGestureViewport: vi.fn(),
    invalidateHarmonyGestureViewport: vi.fn(),
  }));

vi.mock('../hdc.ts', () => ({ runHarmonyShell }));
vi.mock('@agent-device/host-kit/retry', () => ({ sleep }));
vi.mock('../snapshot.ts', () => ({
  readHarmonyGestureViewport,
  invalidateHarmonyGestureViewport,
}));

import {
  appSwitcherHarmony,
  backHarmony,
  doubleClickHarmony,
  fillHarmony,
  homeHarmony,
  longPressHarmony,
  performHarmonyGesture,
  pressHarmony,
  pressHarmonyKeyboardKey,
  scrollHarmony,
  setHarmonyOrientation,
  typeHarmony,
} from '../input-actions.ts';

const DEVICE: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

beforeEach(() => {
  runHarmonyShell.mockReset();
  sleep.mockReset();
  readHarmonyGestureViewport.mockReset();
  invalidateHarmonyGestureViewport.mockReset();
});

test('HarmonyOS input primitives use the documented uiInput command names', async () => {
  await pressHarmony(DEVICE, 10, 20);
  await doubleClickHarmony(DEVICE, 11, 21);
  await longPressHarmony(DEVICE, 12, 22);
  await typeHarmony(DEVICE, 'hello', 25);
  await fillHarmony(DEVICE, 13, 23, 'world', 50);
  await backHarmony(DEVICE);
  await homeHarmony(DEVICE);
  await appSwitcherHarmony(DEVICE);
  await pressHarmonyKeyboardKey(DEVICE, 'Enter');

  assert.deepEqual(
    runHarmonyShell.mock.calls.map(([, args]) => args),
    [
      ['uitest', 'uiInput', 'click', 10, 20],
      ['uitest', 'uiInput', 'doubleClick', 11, 21],
      ['uitest', 'uiInput', 'longClick', 12, 22],
      ['uitest', 'uiInput', 'text', 'hello'],
      ['uitest', 'uiInput', 'inputText', 13, 23, 'world'],
      ['uitest', 'uiInput', 'keyEvent', 'Back'],
      ['uitest', 'uiInput', 'keyEvent', 'Home'],
      ['uitest', 'uiInput', 'keyEvent', 'Recent'],
      ['uitest', 'uiInput', 'keyEvent', 'Enter'],
    ],
  );
  assert.deepEqual(sleep.mock.calls, [[25], [50]]);
  assert.deepEqual(invalidateHarmonyGestureViewport.mock.calls, [[DEVICE], [DEVICE], [DEVICE]]);
});

test('HarmonyOS scroll derives a viewport-aware swipe plan', async () => {
  readHarmonyGestureViewport.mockResolvedValue({ x: 0, y: 0, width: 100, height: 200 });

  const plan = await scrollHarmony(DEVICE, 'down', { amount: 0.5, durationMs: 456 });

  assert.equal(plan.direction, 'down');
  assert.deepEqual(runHarmonyShell.mock.calls[0]?.[1], [
    'uitest',
    'uiInput',
    'swipe',
    plan.x1,
    plan.y1,
    plan.x2,
    plan.y2,
    456,
  ]);
});

const PHONE = { x: 0, y: 0, width: 402, height: 874 };
/** Inset under a navigation bar and above a footer, shorter than a 0.75 swipe. */
const INSET_LIST: Rect = { x: 18, y: 178, width: 366, height: 500 };
/** The same list shifted into an application window that is not at the screen origin. */
const OFFSET_WINDOW = { x: 40, y: 80, width: 402, height: 874 };

function strictlyInside(point: { x: number; y: number }, rect: Rect): boolean {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}

function dispatchedSwipe(callIndex?: number): { x1: number; y1: number; x2: number; y2: number } {
  const calls = runHarmonyShell.mock.calls;
  const call = calls[callIndex ?? calls.length - 1];
  const args = call?.[1] as readonly unknown[];
  return {
    x1: Number(args[3]),
    y1: Number(args[4]),
    x2: Number(args[5]),
    y2: Number(args[6]),
  };
}

test('HarmonyOS scroll keeps an inset list swipe inside the container and reports the shortened span', async () => {
  readHarmonyGestureViewport.mockResolvedValue(PHONE);
  const unclamped = await scrollHarmony(DEVICE, 'down', { amount: 0.75 });
  const outside = dispatchedSwipe(0);
  const result = await scrollHarmony(DEVICE, 'down', { amount: 0.75, containerRect: INSET_LIST });
  const swipe = dispatchedSwipe(1);

  assert.equal(
    strictlyInside({ x: outside.x1, y: outside.y1 }, INSET_LIST) &&
      strictlyInside({ x: outside.x2, y: outside.y2 }, INSET_LIST),
    false,
    'the fixture must leave the list',
  );
  assert.ok(strictlyInside({ x: swipe.x1, y: swipe.y1 }, INSET_LIST), JSON.stringify(swipe));
  assert.ok(strictlyInside({ x: swipe.x2, y: swipe.y2 }, INSET_LIST), JSON.stringify(swipe));
  assert.deepEqual(swipe, { x1: result.x1, y1: result.y1, x2: result.x2, y2: result.y2 });
  assert.equal(result.pixels, Math.abs(Number(result.y2) - Number(result.y1)));
  assert.ok(Number(result.pixels) < Number(unclamped.pixels));
  assert.equal(result.requestedPixels, unclamped.pixels);
});

test('HarmonyOS scroll translates an offset window into the swipe frame before clamping', async () => {
  readHarmonyGestureViewport.mockResolvedValue(OFFSET_WINDOW);
  const list: Rect = {
    x: OFFSET_WINDOW.x + INSET_LIST.x,
    y: OFFSET_WINDOW.y + INSET_LIST.y,
    width: INSET_LIST.width,
    height: INSET_LIST.height,
  };
  const result = await scrollHarmony(DEVICE, 'up', { amount: 0.75, containerRect: list });
  const swipe = dispatchedSwipe();
  const inSnapshotSpace = {
    x1: swipe.x1 + OFFSET_WINDOW.x,
    y1: swipe.y1 + OFFSET_WINDOW.y,
    x2: swipe.x2 + OFFSET_WINDOW.x,
    y2: swipe.y2 + OFFSET_WINDOW.y,
  };

  assert.ok(strictlyInside({ x: inSnapshotSpace.x1, y: inSnapshotSpace.y1 }, list));
  assert.ok(strictlyInside({ x: inSnapshotSpace.x2, y: inSnapshotSpace.y2 }, list));
  assert.ok(Number(result.pixels) < Number(result.requestedPixels));
});

test('HarmonyOS scroll leaves a swipe that already fits its container unchanged', async () => {
  const fitting: Rect = { x: 18, y: 62, width: 366, height: 729 };
  readHarmonyGestureViewport.mockResolvedValue(PHONE);
  const unclamped = await scrollHarmony(DEVICE, 'down', { amount: 0.75 });
  const result = await scrollHarmony(DEVICE, 'down', { amount: 0.75, containerRect: fitting });

  assert.deepEqual(result, unclamped);
  assert.equal('requestedPixels' in result, false);
});

test('HarmonyOS scroll without a container keeps the unclamped swipe', async () => {
  readHarmonyGestureViewport.mockResolvedValue(OFFSET_WINDOW);
  const plan = await scrollHarmony(DEVICE, 'down', { amount: 0.75 });
  const expected = buildScrollGesturePlan({
    direction: 'down',
    amount: 0.75,
    referenceWidth: OFFSET_WINDOW.width,
    referenceHeight: OFFSET_WINDOW.height,
  });

  assert.deepEqual(dispatchedSwipe(), {
    x1: expected.x1,
    y1: expected.y1,
    x2: expected.x2,
    y2: expected.y2,
  });
  assert.equal(plan.pixels, expected.pixels);
  assert.equal('requestedPixels' in plan, false);
});

test('HarmonyOS gestures lower a single trajectory and reject multi-touch', async () => {
  const singlePlan: GesturePlan = {
    topology: 'single',
    intent: 'fling',
    executionProfile: 'timed-pan',
    durationMs: 500,
    viewport: { x: 0, y: 0, width: 100, height: 200 },
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point: { x: 10, y: 20 } },
          { offsetMs: 500, point: { x: 90, y: 120 } },
        ],
      },
    ],
  };

  const result = await performHarmonyGesture(DEVICE, singlePlan);

  assert.deepEqual(result, {
    backend: 'harmonyos-hdc-uiinput',
    command: 'fling',
    velocity: 256,
    viewport: singlePlan.viewport,
  });
  assert.deepEqual(runHarmonyShell.mock.calls[0]?.[1], [
    'uitest',
    'uiInput',
    'fling',
    10,
    20,
    90,
    120,
    256,
  ]);
  await assert.rejects(
    () =>
      performHarmonyGesture(DEVICE, {
        ...singlePlan,
        topology: 'multi',
        intent: 'pinch',
        pointers: [singlePlan.pointers[0], { ...singlePlan.pointers[0], pointerId: 1 }],
      }),
    /does not support multi-touch/,
  );
});

test('HarmonyOS orientation is explicitly unsupported', async () => {
  await assert.rejects(
    () => setHarmonyOrientation(DEVICE, 'landscape-left'),
    /orientation control/,
  );
});
