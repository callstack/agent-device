import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

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

const PANEL_LISTING = [
  'I: Bus=0018 Vendor=0000 Product=0000 Version=0000',
  'N: Name="goodix touchscreen"',
  'H: Handlers=event5',
].join('\n');

const PANEL_MMI_DUMP = [
  'deviceId:4 | deviceName:input_mt_wrapper | deviceType:19 | bus:0 | version:0 | product:0 | vendor:0 | phys:null | isVirtual:0 | isLocal:1',
  '	 axisType:POSITION_Y | minimum:0 | maximum:12831 | fuzz:0 | flat:0 | resolution:1',
  '	 axisType:POSITION_X | minimum:0 | maximum:5759 | fuzz:0 | flat:0 | resolution:1',
].join('\n');

const PORTRAIT_RENDER_DUMP =
  'screen[0]: id=0, powerStatus=POWER_STATUS_ON, screenType=EXTERNAL_TYPE, render resolution=1080x2406, physical resolution=720x1604, isVirtual=false';

const PANEL_DEVICE: DeviceInfo = { ...DEVICE, id: 'harmony-panel-1' };
const LOCKED_DEVICE: DeviceInfo = { ...DEVICE, id: 'harmony-locked-1' };

const PAN_PLAN: GesturePlan = {
  topology: 'single',
  intent: 'pan',
  executionProfile: 'timed-pan',
  durationMs: 320,
  viewport: { x: 0, y: 0, width: 1080, height: 2406 },
  pointers: [
    {
      pointerId: 0,
      samples: [
        { offsetMs: 0, point: { x: 200, y: 2000 } },
        { offsetMs: 320, point: { x: 880, y: 1200 } },
      ],
    },
  ],
};

test('a pan on a locked-down build falls back to the uiInput swipe and reports the reason', async () => {
  runHarmonyShell.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

  const result = await performHarmonyGesture(LOCKED_DEVICE, PAN_PLAN);

  assert.deepEqual(runHarmonyShell.mock.calls[0]?.[1], ['cat', '/proc/bus/input/devices']);
  assert.deepEqual(runHarmonyShell.mock.calls[1]?.[1], [
    'uitest',
    'uiInput',
    'swipe',
    200,
    2000,
    880,
    1200,
    3281,
  ]);
  assert.deepEqual(result, {
    backend: 'harmonyos-hdc-uiinput',
    command: 'swipe',
    velocity: 3281,
    viewport: PAN_PLAN.viewport,
    trajectoryFallback: 'touch-node-listing-unreadable',
  });
});

test('a resolvable pan transport injects the densified script and verifies its success marker', async () => {
  runHarmonyShell
    .mockResolvedValueOnce({ stdout: PANEL_LISTING, stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({ stdout: PANEL_MMI_DUMP, stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({ stdout: PORTRAIT_RENDER_DUMP, stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({
      stdout: 'AGENT_DEVICE_TRAJECTORY_INJECTED',
      stderr: '',
      exitCode: 0,
    });

  const result = await performHarmonyGesture(PANEL_DEVICE, PAN_PLAN);

  assert.deepEqual(runHarmonyShell.mock.calls[0]?.[1], ['cat', '/proc/bus/input/devices']);
  assert.deepEqual(runHarmonyShell.mock.calls[1]?.[1], [
    'hidumper',
    '-s',
    'MultimodalInput',
    '-a',
    '-d',
  ]);
  assert.deepEqual(runHarmonyShell.mock.calls[2]?.[1], [
    'hidumper',
    '-s',
    'RenderService',
    '-a',
    'screen',
  ]);
  const [words, options] = runHarmonyShell.mock.calls[3]?.slice(1) ?? [];
  assert.deepEqual(words?.slice(0, 2), ['sh', '-c']);
  const script = String(words?.[2]);
  assert.ok(script.includes('echo AGENT_DEVICE_TRAJECTORY_INJECTED'));
  assert.ok(script.includes("uinput sendevent '/dev/input/event5' 3 53 1067"));
  assert.ok(script.includes("uinput sendevent '/dev/input/event5' 3 54 10670"));
  assert.ok(options.timeoutMs > PAN_PLAN.durationMs);
  assert.deepEqual(result, {
    backend: 'harmonyos-sendevent-trajectory',
    deviceNode: '/dev/input/event5',
    sampleCount: 21,
    durationMs: 320,
    viewport: PAN_PLAN.viewport,
  });
});

test('a failed panel write reports the typed injection failure instead of success', async () => {
  runHarmonyShell
    .mockResolvedValueOnce({ stdout: PANEL_LISTING, stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({ stdout: PANEL_MMI_DUMP, stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({ stdout: PORTRAIT_RENDER_DUMP, stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({
      stdout: 'Input error in device node, deviceNode:/dev/input/event5',
      stderr: '',
      exitCode: 0,
    });

  await assert.rejects(
    () => performHarmonyGesture({ ...PANEL_DEVICE, id: 'harmony-panel-2' }, PAN_PLAN),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.deepEqual(error.details, {
        reason: 'touch-trajectory-injection-failed',
        deviceNode: '/dev/input/event5',
        sampleCount: 21,
      });
      return true;
    },
  );
});

test('a listed panel with an unreadable axis range falls back instead of writing untransformed points', async () => {
  runHarmonyShell
    .mockResolvedValueOnce({ stdout: PANEL_LISTING, stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({
      stdout: 'deviceId:4 | deviceName:fingerprint | deviceType:3',
      stderr: '',
      exitCode: 0,
    });

  const result = await performHarmonyGesture({ ...PANEL_DEVICE, id: 'harmony-panel-3' }, PAN_PLAN);

  assert.equal(result.backend, 'harmonyos-hdc-uiinput');
  assert.equal(result.trajectoryFallback, 'touch-panel-range-absent');
  assert.deepEqual(runHarmonyShell.mock.calls[2]?.[1], [
    'uitest',
    'uiInput',
    'swipe',
    200,
    2000,
    880,
    1200,
    3281,
  ]);
});
