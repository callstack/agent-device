/**
 * Pointer, key, and gesture actions on an Android device. Text entry — provider injection, the test
 * IME, and the adb-shell writer — is `text-input.ts`.
 */
import { DEVICE_ROTATION_SURFACE_INDEX, type DeviceRotation } from '@agent-device/contracts/device';
import { GESTURE_SAMPLE_INTERVAL_MS, buildGesturePlan } from '@agent-device/contracts/gesture-plan';
import {
  GESTURE_DURATION_MAX_MS,
  GESTURE_DURATION_MIN_MS,
} from '@agent-device/contracts/gesture-plan-types';
import type {
  GesturePlan,
  PointerTrajectorySample,
  SinglePointerTrajectory,
} from '@agent-device/contracts/gesture-plan-types';
import {
  DEFAULT_MOBILE_SCROLL_DURATION_MS,
  type ScrollReleaseBehavior,
} from '@agent-device/contracts/scroll-command';
import {
  type ScrollDirection,
  buildScrollGesturePlan,
} from '@agent-device/contracts/scroll-gesture';
import { type TvRemoteButton, toAndroidTvRemoteKeyevent } from '@agent-device/contracts/tv-remote';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import { sleep } from '@agent-device/host-kit/retry';
import { runAndroidAdb } from './adb.ts';
import { executeAndroidTouchPlan, readAndroidGestureViewport } from './touch-executor.ts';
import type { AndroidHelperSessionOptions } from './snapshot-helper-types.ts';

export async function pressAndroid(device: DeviceInfo, x: number, y: number): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'tap', String(x), String(y)]);
}

export async function pressAndroidTvRemote(
  device: DeviceInfo,
  button: TvRemoteButton,
  durationMs?: number,
): Promise<void> {
  const keyevent = toAndroidTvRemoteKeyevent(button);
  const keyeventArgs = durationMs && durationMs > 0 ? ['keyevent', '--longpress'] : ['keyevent'];
  await runAndroidAdb(device, ['shell', 'input', ...keyeventArgs, keyevent]);
}

export async function backAndroid(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', '4']);
}

export async function homeAndroid(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', '3']);
}

export async function pressAndroidEnter(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', 'ENTER']);
}

export async function setAndroidOrientation(
  device: DeviceInfo,
  orientation: DeviceRotation,
): Promise<void> {
  const userRotation = resolveAndroidUserRotation(orientation);
  await runAndroidAdb(device, [
    'shell',
    'settings',
    'put',
    'system',
    'accelerometer_rotation',
    '0',
  ]);
  await runAndroidAdb(device, [
    'shell',
    'settings',
    'put',
    'system',
    'user_rotation',
    userRotation,
  ]);
  await settleAndroidOrientation(device, orientation, userRotation);
}

const ORIENTATION_SETTLE_TIMEOUT_MS = 15_000;
const ORIENTATION_SETTLE_POLL_MS = 500;

/**
 * The display rotates some time after the setting lands; on a loaded emulator that takes
 * seconds, during which accessibility reads hang. Returning once the display reports the
 * requested rotation keeps the next command from paying for the transition. A display that never
 * gets there is a fact the caller must see (a foreground app pinning its orientation, a device
 * ignoring `user_rotation`); one that reports no rotation at all cannot be checked and is left to
 * the setting.
 */
async function settleAndroidOrientation(
  device: DeviceInfo,
  orientation: DeviceRotation,
  userRotation: string,
): Promise<void> {
  const deadline = Date.now() + ORIENTATION_SETTLE_TIMEOUT_MS;
  let observed = await readAndroidDisplayRotation(device, orientation, deadline);
  while (observed !== undefined && observed !== userRotation && Date.now() < deadline) {
    await sleep(Math.min(ORIENTATION_SETTLE_POLL_MS, remainingMs(deadline)));
    observed = await readAndroidDisplayRotation(device, orientation, deadline);
  }
  if (observed === undefined || observed === userRotation) return;
  throw new AppError(
    'COMMAND_FAILED',
    `orientation ${orientation} did not take effect: the display still reports rotation ${observed} after ${ORIENTATION_SETTLE_TIMEOUT_MS}ms`,
    {
      requestedRotation: Number(userRotation),
      observedRotation: Number(observed),
      hint: 'The foreground app may pin its orientation, or the device may ignore user_rotation. Check `adb shell dumpsys display | grep mCurrentOrientation` and the app manifest.',
    },
  );
}

/**
 * One display read, bounded by what is left of the settle budget so a stuck probe ends the
 * settle. A probe that fails (non-zero exit, timeout) is a failed settle, never "no field".
 */
async function readAndroidDisplayRotation(
  device: DeviceInfo,
  orientation: DeviceRotation,
  deadline: number,
): Promise<string | undefined> {
  try {
    const result = await runAndroidAdb(device, ['shell', 'dumpsys', 'display'], {
      timeoutMs: remainingMs(deadline),
    });
    return /mCurrentOrientation=(\d)/.exec(result.stdout)?.[1];
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `orientation ${orientation} could not confirm the display rotation: ${error instanceof Error ? error.message : String(error)}`,
      { hint: 'The device did not answer `dumpsys display` within the orientation budget.' },
    );
  }
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

export async function appSwitcherAndroid(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', '187']);
}

export async function longPressAndroid(
  device: DeviceInfo,
  x: number,
  y: number,
  durationMs = 800,
): Promise<Record<string, unknown>> {
  const point = { x, y };
  return await executeAndroidTouchPlan(device, {
    topology: 'single',
    intent: 'longPress',
    durationMs,
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point },
          { offsetMs: durationMs, point },
        ],
      },
    ],
  });
}

export async function focusAndroid(device: DeviceInfo, x: number, y: number): Promise<void> {
  await pressAndroid(device, x, y);
}

export async function scrollAndroid(
  device: DeviceInfo,
  direction: ScrollDirection,
  options?: {
    amount?: number;
    pixels?: number;
    durationMs?: number;
    releaseBehavior?: ScrollReleaseBehavior;
  } & AndroidHelperSessionOptions,
): Promise<Record<string, unknown>> {
  // The viewport read and the gesture are two helper calls one command apart: giving the read the
  // command's session scope keeps both on the same instrumentation.
  const viewport = await readAndroidGestureViewport(device, {
    helperSessionScope: options?.helperSessionScope,
  });
  const relativePlan = buildScrollGesturePlan({
    direction,
    amount: options?.amount,
    pixels: options?.pixels,
    referenceWidth: viewport.width,
    referenceHeight: viewport.height,
  });
  const scrollPlan = {
    ...relativePlan,
    // Injected coordinates are absolute, so their zero-origin reference frame
    // must include the viewport offset as well as its dimensions.
    referenceWidth: viewport.x + viewport.width,
    referenceHeight: viewport.y + viewport.height,
    x1: viewport.x + relativePlan.x1,
    y1: viewport.y + relativePlan.y1,
    x2: viewport.x + relativePlan.x2,
    y2: viewport.y + relativePlan.y2,
  };
  const durationMs = Math.max(
    options?.durationMs ?? DEFAULT_MOBILE_SCROLL_DURATION_MS,
    GESTURE_DURATION_MIN_MS,
  );
  const releaseBehavior = options?.releaseBehavior ?? 'controlled';
  if (releaseBehavior === 'controlled') assertRoomForControlledReleaseTail(durationMs);
  const gesturePlan = buildGesturePlan(
    {
      intent: 'pan',
      origin: { x: scrollPlan.x1, y: scrollPlan.y1 },
      delta: {
        x: scrollPlan.x2 - scrollPlan.x1,
        y: scrollPlan.y2 - scrollPlan.y1,
      },
      durationMs,
    },
    viewport,
    'android',
  );
  const backend = await executeAndroidTouchPlan(
    device,
    releaseBehavior === 'controlled'
      ? withControlledReleaseTail(gesturePlan, viewport, direction)
      : gesturePlan,
  );

  return {
    ...scrollPlan,
    ...(options?.durationMs !== undefined ? { durationMs } : {}),
    ...backend,
  };
}

// Kept an even multiple of GESTURE_SAMPLE_INTERVAL_MS so the tail's last sample lands back on the
// pan's exact endpoint (an odd multiple would still avoid the fling — every consecutive sample
// still differs — but would leave the release 1px off the requested endpoint).
const CONTROLLED_RELEASE_TAIL_MS = 160;

// The dispatched plan (move + tail) must never exceed GESTURE_DURATION_MAX_MS, the same ceiling
// every gesture plan is built under. Rather than silently dropping the tail for a move that
// leaves it no room, a controlled scroll's own accepted range stops short of the shared ceiling
// by the tail's length — the full tail runs for every accepted controlled scroll, and a request
// past this narrower range is rejected with the reason, not truncated.
const CONTROLLED_RELEASE_MAX_MOVE_MS = GESTURE_DURATION_MAX_MS - CONTROLLED_RELEASE_TAIL_MS;

function assertRoomForControlledReleaseTail(durationMs: number): void {
  if (durationMs <= CONTROLLED_RELEASE_MAX_MOVE_MS) return;
  throw new AppError(
    'INVALID_ARGS',
    `scroll durationMs must be at most ${CONTROLLED_RELEASE_MAX_MOVE_MS} for a controlled release ` +
      `(leaves room for the ${CONTROLLED_RELEASE_TAIL_MS}ms release tail within the ` +
      `${GESTURE_DURATION_MAX_MS}ms gesture ceiling)`,
    {
      hint: "Pass a shorter durationMs, or releaseBehavior 'inertial' if the fling is acceptable.",
    },
  );
}

/**
 * A short, quivering tail appended after a 'controlled' scroll's endpoint, adding
 * `CONTROLLED_RELEASE_TAIL_MS` of real time to the gesture. AOSP's `InputConsumer::rewriteMessage`
 * collapses a MOVE that repeats the previous coordinates into a "resampled" sample, and
 * `VelocityTracker` skips resampled samples — so a truly stationary tail never reaches the
 * tracker, and `ScrollView.onTouchEvent` (which computes release velocity before applying UP)
 * still flings at the pan's velocity. Nudging the axis orthogonal to the scroll by 1px every frame
 * (holding the scroll axis exactly at the endpoint — zero velocity there by construction) keeps
 * every sample distinct without adding net travel along either axis. Measured fling-free for
 * vertical scrolls on a `RecyclerView` and an RN `ScrollView` (issue #2371); not independently
 * verified against every OEM skin or a Compose `LazyColumn`. An 'inertial' release (the
 * `scroll top`/`scroll bottom` edge passes) lifts at the pan's endpoint unchanged.
 *
 * Callers must have already checked `assertRoomForControlledReleaseTail` on the move duration —
 * this always appends the full tail.
 */
function withControlledReleaseTail(
  plan: GesturePlan,
  viewport: Rect,
  direction: ScrollDirection,
): GesturePlan {
  if (plan.topology !== 'single') return plan;
  const steps = CONTROLLED_RELEASE_TAIL_MS / GESTURE_SAMPLE_INTERVAL_MS;
  const [pointer] = plan.pointers;
  const end = pointer.samples.at(-1)!;
  const horizontal = direction === 'left' || direction === 'right';
  const jitterBase = horizontal ? end.point.y : end.point.x;
  const jitterMin = (horizontal ? viewport.y : viewport.x) + 1;
  const jitterMax = (horizontal ? viewport.y + viewport.height : viewport.x + viewport.width) - 1;
  const nudged = jitterBase + 1 <= jitterMax ? jitterBase + 1 : Math.max(jitterMin, jitterBase - 1);
  const tail: PointerTrajectorySample[] = Array.from({ length: steps }, (_, index) => {
    const jitter = index % 2 === 0 ? nudged : jitterBase;
    return {
      offsetMs: plan.durationMs + (index + 1) * GESTURE_SAMPLE_INTERVAL_MS,
      point: horizontal ? { x: end.point.x, y: jitter } : { x: jitter, y: end.point.y },
    };
  });
  const samples: SinglePointerTrajectory['samples'] = [
    pointer.samples[0],
    pointer.samples[1],
    ...pointer.samples.slice(2),
    ...tail,
  ];
  return {
    ...plan,
    durationMs: plan.durationMs + CONTROLLED_RELEASE_TAIL_MS,
    pointers: [{ ...pointer, samples }],
  };
}

function resolveAndroidUserRotation(orientation: DeviceRotation): string {
  const index = DEVICE_ROTATION_SURFACE_INDEX[orientation];
  if (index === undefined) {
    throw new AppError('INVALID_ARGS', `Unsupported Android rotation: ${orientation}`);
  }
  return String(index);
}

export async function getAndroidScreenSize(
  device: DeviceInfo,
): Promise<{ width: number; height: number }> {
  const result = await runAndroidAdb(device, ['shell', 'wm', 'size']);
  const match = result.stdout.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) throw new AppError('COMMAND_FAILED', 'Unable to read screen size');
  return { width: Number(match[1]), height: Number(match[2]) };
}
