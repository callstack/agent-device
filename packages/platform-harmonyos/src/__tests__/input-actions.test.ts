import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyHdcRunnerStub } from '../toolbox.fixtures.ts';

const { sleep, readHarmonyGestureViewport, invalidateHarmonyGestureViewport } = vi.hoisted(() => ({
  sleep: vi.fn(async (_milliseconds: number) => undefined),
  readHarmonyGestureViewport: vi.fn(),
  invalidateHarmonyGestureViewport: vi.fn(),
}));

// The one timer this family owns paces one HDC write after another. It is the plain Node timer rather
// than the host-kit retry scope's, whose module the plugin would bundle with its own diagnostic store,
// so the suite stands it in here.
vi.mock('node:timers/promises', () => ({ setTimeout: sleep }));
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

let hdc: ReturnType<typeof createHarmonyHdcRunnerStub>;

beforeEach(() => {
  hdc = createHarmonyHdcRunnerStub();
  sleep.mockReset();
  readHarmonyGestureViewport.mockReset();
  invalidateHarmonyGestureViewport.mockReset();
});

/** The shell words of every HDC call the module made. */
function shellWords(): readonly (readonly unknown[])[] {
  return hdc.calls.map((call) => call.args);
}

test('HarmonyOS input primitives use the documented uiInput command names', async () => {
  await pressHarmony(hdc, DEVICE, 10, 20);
  await doubleClickHarmony(hdc, DEVICE, 11, 21);
  await longPressHarmony(hdc, DEVICE, 12, 22);
  await typeHarmony(hdc, DEVICE, 'hello', 25);
  await fillHarmony(hdc, DEVICE, 13, 23, 'world', 50);
  await backHarmony(hdc, DEVICE);
  await homeHarmony(hdc, DEVICE);
  await appSwitcherHarmony(hdc, DEVICE);
  await pressHarmonyKeyboardKey(hdc, DEVICE, 'Enter');

  assert.deepEqual(shellWords(), [
    ['uitest', 'uiInput', 'click', 10, 20],
    ['uitest', 'uiInput', 'doubleClick', 11, 21],
    ['uitest', 'uiInput', 'longClick', 12, 22],
    ['uitest', 'uiInput', 'text', 'hello'],
    ['uitest', 'uiInput', 'inputText', 13, 23, 'world'],
    ['uitest', 'uiInput', 'keyEvent', 'Back'],
    ['uitest', 'uiInput', 'keyEvent', 'Home'],
    ['uitest', 'uiInput', 'keyEvent', 'Recent'],
    ['uitest', 'uiInput', 'keyEvent', 'Enter'],
  ]);
  // Every call went to the one device this interactor was created for.
  assert.deepEqual([...new Set(hdc.calls.map((call) => call.target))], ['harmony-1']);
  assert.deepEqual(sleep.mock.calls, [[25], [50]]);
  assert.deepEqual(invalidateHarmonyGestureViewport.mock.calls, [[DEVICE], [DEVICE], [DEVICE]]);
});

test('HarmonyOS scroll derives a viewport-aware swipe plan', async () => {
  readHarmonyGestureViewport.mockResolvedValue({ x: 0, y: 0, width: 100, height: 200 });

  const plan = await scrollHarmony(hdc, DEVICE, 'down', { amount: 0.5, durationMs: 456 });

  assert.equal(plan.direction, 'down');
  assert.deepEqual(hdc.calls[0]?.args, [
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

  const result = await performHarmonyGesture(hdc, DEVICE, singlePlan);

  assert.deepEqual(result, {
    backend: 'harmonyos-hdc-uiinput',
    command: 'fling',
    velocity: 256,
    viewport: singlePlan.viewport,
  });
  assert.deepEqual(hdc.calls[0]?.args, ['uitest', 'uiInput', 'fling', 10, 20, 90, 120, 256]);
  await assert.rejects(
    () =>
      performHarmonyGesture(hdc, DEVICE, {
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
