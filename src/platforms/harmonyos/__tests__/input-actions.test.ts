import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { GesturePlan } from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { runHarmonyHdc, sleep, readHarmonyGestureViewport } = vi.hoisted(() => ({
  runHarmonyHdc: vi.fn(),
  sleep: vi.fn(),
  readHarmonyGestureViewport: vi.fn(),
}));

vi.mock('../hdc.ts', () => ({ runHarmonyHdc }));
vi.mock('../../../utils/timeouts.ts', () => ({ sleep }));
vi.mock('../snapshot.ts', () => ({ readHarmonyGestureViewport }));

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
  runHarmonyHdc.mockReset();
  sleep.mockReset();
  readHarmonyGestureViewport.mockReset();
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
    runHarmonyHdc.mock.calls.map(([, args]) => args),
    [
      ['shell', 'uitest', 'uiInput', 'click', '10', '20'],
      ['shell', 'uitest', 'uiInput', 'doubleClick', '11', '21'],
      ['shell', 'uitest', 'uiInput', 'longClick', '12', '22'],
      ['shell', 'uitest', 'uiInput', 'text', 'hello'],
      ['shell', 'uitest', 'uiInput', 'inputText', '13', '23', 'world'],
      ['shell', 'uitest', 'uiInput', 'keyEvent', 'Back'],
      ['shell', 'uitest', 'uiInput', 'keyEvent', 'Home'],
      ['shell', 'uitest', 'uiInput', 'keyEvent', 'Recent'],
      ['shell', 'uitest', 'uiInput', 'keyEvent', 'Enter'],
    ],
  );
  assert.deepEqual(sleep.mock.calls, [[25], [50]]);
});

test('HarmonyOS scroll derives a viewport-aware swipe plan', async () => {
  readHarmonyGestureViewport.mockResolvedValue({ x: 0, y: 0, width: 100, height: 200 });

  const plan = await scrollHarmony(DEVICE, 'down', { amount: 0.5, durationMs: 456 });

  assert.equal(plan.direction, 'down');
  assert.deepEqual(runHarmonyHdc.mock.calls[0]?.[1], [
    'shell',
    'uitest',
    'uiInput',
    'swipe',
    String(plan.x1),
    String(plan.y1),
    String(plan.x2),
    String(plan.y2),
    '456',
  ]);
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
  assert.deepEqual(runHarmonyHdc.mock.calls[0]?.[1], [
    'shell',
    'uitest',
    'uiInput',
    'fling',
    '10',
    '20',
    '90',
    '120',
    '256',
  ]);
  await assert.rejects(
    () =>
      performHarmonyGesture(DEVICE, {
        ...singlePlan,
        topology: 'two',
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
