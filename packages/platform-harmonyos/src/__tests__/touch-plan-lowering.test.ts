import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { SinglePointerGesturePlan } from '@agent-device/contracts/gesture-plan-types';
import {
  type HarmonyPanelTransform,
  HARMONY_TOUCH_TRANSPORT_MAX_SAMPLES,
  harmonyTrajectoryTimeoutMs,
  lowerHarmonyTouchPlan,
  parseHarmonyRenderResolution,
  parseHarmonyTouchDeviceNode,
  parseHarmonyTouchPanelRange,
  renderHarmonyTouchScript,
  resolveHarmonyPanelTransform,
  TRAJECTORY_INJECTION_SENTINEL,
} from '../touch-plan-lowering.ts';

const RANGE = { minX: 0, maxX: 5759, minY: 0, maxY: 12831 };
const TRANSFORM: HarmonyPanelTransform = {
  displayWidth: 1080,
  displayHeight: 2406,
  range: RANGE,
};

function panPlan(durationMs: number): SinglePointerGesturePlan {
  return {
    topology: 'single',
    intent: 'pan',
    executionProfile: 'timed-pan',
    durationMs,
    viewport: { x: 0, y: 0, width: 1080, height: 2406 },
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point: { x: 200, y: 2000 } },
          { offsetMs: durationMs, point: { x: 880, y: 1200 } },
        ],
      },
    ],
  };
}

test('the lowering keeps endpoints and duration and carries dense ordered interior reports', () => {
  const trajectory = lowerHarmonyTouchPlan(panPlan(320), TRANSFORM);

  assert.equal(trajectory.durationMs, 320);
  // floor(320 / 16) frames + 1: the 16 ms sampling grid densifies the two canonical endpoints.
  assert.equal(trajectory.sampleCount, 21);
  assert.equal(trajectory.samples.length, trajectory.sampleCount);

  const first = trajectory.samples[0]!;
  assert.equal(first.delayMs, 0);
  assert.ok(
    first.events.some((event) => event.type === 3 && event.code === 0x35 && event.value === 1067),
  );
  assert.ok(
    first.events.some((event) => event.type === 3 && event.code === 0x36 && event.value === 10670),
  );

  const last = trajectory.samples.at(-1)!;
  assert.ok(last.events.some((event) => event.code === 0x35 && event.value === 4697));
  assert.ok(last.events.some((event) => event.code === 0x36 && event.value === 6402));
  assert.ok(last.events.some((event) => event.code === 0x39 && event.value === -1));
  assert.ok(last.events.some((event) => event.code === 0x14a && event.value === 0));

  // Offsets land on the 16 ms grid, so every interior and final pacing gap is exactly 16 ms.
  const interior = trajectory.samples.slice(1, -1);
  assert.equal(interior.length, 19);
  for (const sample of interior) assert.equal(sample.delayMs, 16);
  assert.equal(last.delayMs, 16);

  // The midpoint sample at offset 160 sits exactly halfway along the canonical line.
  const midpoint = trajectory.samples[10]!;
  assert.ok(midpoint.events.some((event) => event.code === 0x35 && event.value === 2882));
  assert.ok(midpoint.events.some((event) => event.code === 0x36 && event.value === 8536));
});

test('a long pan subsamples under the transport budget and keeps both endpoint reports', () => {
  const trajectory = lowerHarmonyTouchPlan(panPlan(1600), TRANSFORM);

  assert.ok(trajectory.sampleCount <= HARMONY_TOUCH_TRANSPORT_MAX_SAMPLES);
  assert.equal(trajectory.sampleCount, HARMONY_TOUCH_TRANSPORT_MAX_SAMPLES);
  const first = trajectory.samples[0]!;
  const last = trajectory.samples.at(-1)!;
  assert.ok(first.events.some((event) => event.code === 0x35 && event.value === 1067));
  assert.ok(first.events.some((event) => event.code === 0x36 && event.value === 10670));
  assert.ok(last.events.some((event) => event.code === 0x35 && event.value === 4697));
  assert.ok(last.events.some((event) => event.code === 0x36 && event.value === 6402));
});

test('a multi-touch plan refuses the sendevent transport with the typed error', () => {
  const plan = {
    ...panPlan(320),
    topology: 'multi',
    intent: 'pinch',
    pointers: [panPlan(320).pointers[0]!, { ...panPlan(320).pointers[0]!, pointerId: 1 }],
  } as unknown as SinglePointerGesturePlan;

  assert.throws(
    () => lowerHarmonyTouchPlan(plan, TRANSFORM),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      return true;
    },
  );
});

test('the rendered script paces each sleep before its sample and never sleeps before the down frame', () => {
  const trajectory = lowerHarmonyTouchPlan(panPlan(320), TRANSFORM);
  const script = renderHarmonyTouchScript(trajectory, { deviceNode: '/dev/input/event5' });
  const steps = script.split(' && ');

  assert.equal(steps[0], "( uinput sendevent '/dev/input/event5' 3 47 0");
  assert.ok(!steps.slice(0, 6).some((step) => step.startsWith('sleep ')));
  assert.equal(steps[6], 'sleep 0.016');
  // The first interior sample sits 5% along the line: x = 234 display px → 1249 panel units.
  assert.equal(steps[7], "uinput sendevent '/dev/input/event5' 3 53 1249");

  const sleepCount = steps.filter((step) => step.startsWith('sleep ')).length;
  assert.equal(sleepCount, trajectory.sampleCount - 1);

  // The final up frame's pacing sleep precedes its position write too.
  const sentinelIndex = steps.findIndex((step) =>
    step.startsWith(`echo ${TRAJECTORY_INJECTION_SENTINEL}`),
  );
  assert.ok(sentinelIndex > 0);
  const lastSleepIndex = steps.map((step) => step.startsWith('sleep ')).lastIndexOf(true);
  assert.ok(lastSleepIndex > 0 && lastSleepIndex < sentinelIndex);
  assert.equal(steps[lastSleepIndex + 1], "uinput sendevent '/dev/input/event5' 3 53 4697");
});

test('the rendered script joins the chain with &&, ends on the success marker, and releases the contact on failure', () => {
  const trajectory = lowerHarmonyTouchPlan(panPlan(320), TRANSFORM);
  const script = renderHarmonyTouchScript(trajectory, {
    deviceNode: '/dev/input/event5',
    sendEventSpawnOverheadMs: 10,
  });

  const successBranch = script.slice(0, script.indexOf(') || ('));
  const releaseBranch = script.slice(script.indexOf(') || ('));
  assert.ok(script.startsWith('( '));
  assert.ok(successBranch.includes(`echo ${TRAJECTORY_INJECTION_SENTINEL}`));

  // The overhead estimate sheds the per-sample pacing: 16 ms minus 10 ms spawn cost.
  assert.ok(successBranch.includes('sleep 0.006'));
  assert.ok(!successBranch.includes('sleep 0.016'));

  // The release branch re-sends the final up frame: final point, tracking id -1, BTN_TOUCH 0.
  assert.ok(releaseBranch.includes("uinput sendevent '/dev/input/event5' 3 53 4697"));
  assert.ok(releaseBranch.includes("uinput sendevent '/dev/input/event5' 3 54 6402"));
  assert.ok(releaseBranch.includes("uinput sendevent '/dev/input/event5' 3 57 -1"));
  assert.ok(releaseBranch.includes("uinput sendevent '/dev/input/event5' 1 330 0"));
  // The branch closes after the release frame's final SYN_REPORT.
  assert.ok(
    releaseBranch.replace(/[)\s]*$/, '').endsWith("uinput sendevent '/dev/input/event5' 0 0 0"),
  );
});

test('the injection timeout covers duration, per-sample spawn budget, and margin', () => {
  const trajectory = lowerHarmonyTouchPlan(panPlan(320), TRANSFORM);
  assert.equal(harmonyTrajectoryTimeoutMs(trajectory), 320 + 21 * 120 + 1500);
});

test('the node parser picks the touch panel and skips touch-named fingerprint and key devices', () => {
  const listing = [
    'I: Bus=0018 Vendor=0000 Product=0000 Version=0000',
    'N: Name="touchscreen fingerprint"',
    'H: Handlers=event2',
    '',
    'I: Bus=0018 Vendor=0000 Product=0000 Version=0000',
    'N: Name="touchscreen gpio-keys"',
    'H: Handlers=event3',
    '',
    'I: Bus=0018 Vendor=0000 Product=0000 Version=0000',
    'N: Name="goodix touchscreen"',
    'H: Handlers=event5',
  ].join('\n');

  assert.equal(parseHarmonyTouchDeviceNode(listing), '/dev/input/event5');
  assert.equal(parseHarmonyTouchDeviceNode('N: Name="gpio-keys"\nH: Handlers=event2'), undefined);
});

test('the axis range parser reads the MMI dump and reports disagreement as ambiguous', () => {
  const agreeing = [
    'deviceId:4 | deviceName:input_mt_wrapper | deviceType:19 | bus:0 | version:0 | product:0 | vendor:0 | phys:null | isVirtual:0 | isLocal:1',
    '	 axisType:POSITION_Y | minimum:0 | maximum:12831 | fuzz:0 | flat:0 | resolution:1',
    '	 axisType:POSITION_X | minimum:0 | maximum:5759 | fuzz:0 | flat:0 | resolution:1',
    'deviceId:5 | deviceName:thp_extra_object_dev | deviceType:17 | bus:0 | version:0 | product:0 | vendor:0 | phys:null | isVirtual:0 | isLocal:1',
    '	 axisType:POSITION_Y | minimum:0 | maximum:12831 | fuzz:0 | flat:0 | resolution:1',
    '	 axisType:POSITION_X | minimum:0 | maximum:5759 | fuzz:0 | flat:0 | resolution:1',
  ].join('\n');
  const range = parseHarmonyTouchPanelRange(agreeing);
  assert.deepEqual(range, { kind: 'range', range: { minX: 0, maxX: 5759, minY: 0, maxY: 12831 } });

  const disagreeing = `${agreeing}\ndeviceId:6 | deviceName:other_panel | deviceType:19 | bus:0\n	 axisType:POSITION_Y | minimum:0 | maximum:2399 | fuzz:0 | flat:0 | resolution:1\n	 axisType:POSITION_X | minimum:0 | maximum:1079 | fuzz:0 | flat:0 | resolution:1`;
  assert.deepEqual(parseHarmonyTouchPanelRange(disagreeing), { kind: 'ambiguous' });

  const withoutPosition = 'deviceId:1 | deviceName:fingerprint | deviceType:3 | bus:0';
  assert.deepEqual(parseHarmonyTouchPanelRange(withoutPosition), { kind: 'absent' });
});

test('the render resolution parser reads the RenderService screen dump', () => {
  const dump =
    'screen[0]: id=0, powerStatus=POWER_STATUS_ON, backlight=27, screenType=EXTERNAL_TYPE, render resolution=1080x2406, physical resolution=720x1604, isVirtual=false';
  assert.deepEqual(parseHarmonyRenderResolution(dump), { width: 1080, height: 2406 });
  assert.equal(parseHarmonyRenderResolution('no screen info'), undefined);
});

test('the panel transform resolves portrait shapes and refuses rotation and unreadable dumps', () => {
  const resolved = resolveHarmonyPanelTransform(
    RANGE,
    { width: 1080, height: 2406 },
    { width: 1080, height: 2406 },
  );
  assert.deepEqual(resolved, { kind: 'transform', transform: TRANSFORM });

  // A landscape render resolution needs axis transposition the transport has not verified.
  assert.deepEqual(
    resolveHarmonyPanelTransform(
      RANGE,
      { width: 2406, height: 1080 },
      { width: 2406, height: 1080 },
    ),
    { kind: 'display-rotation-unsupported' },
  );
  // A landscape app window inside a portrait render means the same refusal.
  assert.deepEqual(
    resolveHarmonyPanelTransform(
      RANGE,
      { width: 1080, height: 2406 },
      { width: 2406, height: 1080 },
    ),
    { kind: 'display-rotation-unsupported' },
  );
  assert.deepEqual(resolveHarmonyPanelTransform(RANGE, undefined, { width: 10, height: 20 }), {
    kind: 'render-resolution-unreadable',
  });
});
