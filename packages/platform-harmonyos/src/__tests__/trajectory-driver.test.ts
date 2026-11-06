import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  PointerTrajectorySample,
  SinglePointerGesturePlan,
} from '@agent-device/contracts/gesture-plan-types';

const { runHarmonyShell } = vi.hoisted(() => ({ runHarmonyShell: vi.fn() }));

vi.mock('../hdc.ts', () => ({ runHarmonyShell }));

import {
  HARMONY_TRAJECTORY_DRIVER_BUNDLE,
  injectHarmonyTrajectoryViaDriver,
  isHarmonyTrajectoryDriverInstalled,
  parseCarrierDetail,
  renderHarmonyTrajectoryJson,
  renderHarmonyTrajectoryRequest,
} from '../trajectory-driver.ts';

const DEVICE: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-driver-1',
  name: 'HarmonyOS test device',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

function planOf(points: { x: number; y: number }[], durationMs: number): SinglePointerGesturePlan {
  const span = durationMs / (points.length - 1);
  return {
    topology: 'single',
    intent: 'pan',
    executionProfile: 'timed-pan',
    durationMs,
    viewport: { x: 0, y: 0, width: 1080, height: 2400 },
    pointers: [
      {
        pointerId: 0,
        // Cast mirrors the generator boundary: planOf always receives >= 2 points, and the
        // canonical plan type wants the non-empty tuple the builder guarantees.
        samples: points.map((point, index) => ({
          offsetMs: Math.round(span * index),
          point,
        })) as [PointerTrajectorySample, PointerTrajectorySample, ...PointerTrajectorySample[]],
      },
    ],
  };
}

beforeEach(() => {
  runHarmonyShell.mockReset();
});

test('the request renderer rounds steps and derives the pacing speed from path over duration', () => {
  const request = renderHarmonyTrajectoryRequest(
    planOf(
      [
        { x: 10.6, y: 20.4 },
        { x: 110.2, y: 120.8 },
        { x: 210, y: 220 },
      ],
      900,
    ),
  );
  assert.deepEqual(request.steps, [
    { x: 11, y: 20 },
    { x: 110, y: 121 },
    { x: 210, y: 220 },
  ]);
  // Rounded steps give two segments of ~141.4 and ~140.7px over 0.9s: ~313 px/s.
  assert.equal(request.speed, 313);
});

test('the pacing speed clamps into the platform range', () => {
  const fast = renderHarmonyTrajectoryRequest(
    planOf(
      [
        { x: 0, y: 0 },
        { x: 900, y: 0 },
      ],
      16,
    ),
  );
  const slow = renderHarmonyTrajectoryRequest(
    planOf(
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ],
      10_000,
    ),
  );
  assert.equal(fast.speed, 40000);
  assert.equal(slow.speed, 200);
});

test('the rendered request JSON carries steps and speed', () => {
  const json = renderHarmonyTrajectoryJson({ speed: 600, steps: [{ x: 1, y: 2 }] });
  assert.deepEqual(JSON.parse(json), { steps: [{ x: 1, y: 2 }], speed: 600 });
});

test('the install check reads the bundle answer shape and caches per device', async () => {
  runHarmonyShell.mockResolvedValueOnce({
    stdout: `Bundle name: ${HARMONY_TRAJECTORY_DRIVER_BUNDLE}\nappId: 1`,
    stderr: '',
  });
  assert.equal(await isHarmonyTrajectoryDriverInstalled(DEVICE), true);
  runHarmonyShell.mockResolvedValueOnce({ stdout: '', stderr: 'get bundle info failed' });
  assert.equal(
    await isHarmonyTrajectoryDriverInstalled({ ...DEVICE, id: 'harmony-driver-2' }),
    false,
  );
  const calls = runHarmonyShell.mock.calls.map(([, args]) => args);
  assert.deepEqual(calls[0], ['bm', 'dump', '-n', HARMONY_TRAJECTORY_DRIVER_BUNDLE]);
});

test('the driver injection sends one daemon-prestarted aa test script and reads the hilog verdict', async () => {
  runHarmonyShell.mockResolvedValueOnce({
    stdout: 'ADTRAJ_RESULT {"ok":true,"sampleCount":2,"speed":283,"error":"elapsed 1624ms"}\n',
    stderr: '',
  });
  const outcome = await injectHarmonyTrajectoryViaDriver(
    DEVICE,
    planOf(
      [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
      ],
      500,
    ),
  );
  assert.deepEqual(
    {
      backend: outcome.backend,
      accepted: outcome.accepted,
      sampleCount: outcome.sampleCount,
      speed: outcome.speed,
    },
    {
      backend: 'harmonyos-uitest-inputpointer',
      accepted: true,
      sampleCount: 2,
      speed: 283,
    },
  );
  const call = runHarmonyShell.mock.calls[0]!;
  const [deviceArg, words, options] = call;
  assert.equal(deviceArg.id, DEVICE.id);
  assert.deepEqual(words.slice(0, 2), ['sh', '-c']);
  const script = words[2] as string;
  assert.match(script, /^uitest start-daemon adtraj &\n/);
  assert.match(script, new RegExp(`aa test -b ${HARMONY_TRAJECTORY_DRIVER_BUNDLE} -m entry_test`));
  const trajMatch = /-s traj '([^']+)'/.exec(script)!;
  const request = JSON.parse(trajMatch[1]!);
  assert.equal(request.speed, 283);
  assert.equal(request.steps.length, 2);
  assert.match(script, /hilog -x \| grep ADTRAJ_RESULT/);
  assert.ok(options.timeoutMs > 500);
  assert.equal(options.allowFailure, true);
});

test('the carrier hilog verdict decides acceptance and carries the error detail', async () => {
  runHarmonyShell.mockResolvedValueOnce({
    stdout:
      'ADTRAJ_RESULT {"ok":false,"sampleCount":0,"speed":0,"error":"inject failed: 17000006 ipc connection is dead"}\n',
    stderr: '',
  });
  const refused = await injectHarmonyTrajectoryViaDriver(
    DEVICE,
    planOf(
      [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
      ],
      500,
    ),
  );
  assert.equal(refused.accepted, false);
  assert.match(refused.detail, /ipc connection is dead/);
});

test('a refused injection names the carrier detail instead of a bare failure', async () => {
  runHarmonyShell.mockResolvedValueOnce({
    stdout:
      'ohosTest run: fail: [adtraj] injectTrajectory injectMultiPointerAction returned false\n',
    stderr: '',
  });
  const outcome = await injectHarmonyTrajectoryViaDriver(
    DEVICE,
    planOf(
      [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
      ],
      500,
    ),
  );
  assert.equal(outcome.accepted, false);
  assert.match(outcome.detail, /injectMultiPointerAction returned false/);
});

test('the detail parser picks the runner assertion and the inject error', () => {
  assert.equal(
    parseCarrierDetail('fail: [adtraj] injectTrajectory parse failed: missing traj'),
    'parse failed: missing traj',
  );
  assert.equal(
    parseCarrierDetail('some log\ninject failed: 401 parameter error\nmore'),
    '401 parameter error',
  );
  assert.equal(parseCarrierDetail('pass: adtraj_injectTrajectory'), undefined);
});
