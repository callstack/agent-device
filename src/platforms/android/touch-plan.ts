import {
  interpolateGesturePoint,
  sampleGestureOffsets,
  type GesturePlan,
  type MultiTouchGesturePlan,
  type PointerTrajectory,
  type PointerTrajectorySample,
  type SinglePointerGesturePlan,
} from '@agent-device/contracts/interaction';
import type { Rect } from '@agent-device/kernel/snapshot';

export type AndroidLongPressTouchPlan = {
  topology: 'single';
  intent: 'longPress';
  durationMs: number;
  pointers: readonly [PointerTrajectory];
};

export type AndroidTouchPlan = GesturePlan | AndroidLongPressTouchPlan;

/**
 * Transport samples are strictly denser than the canonical endpoint pair, so the shared plan a
 * command builds cannot satisfy the transport types: skipping the lowering below is a type error
 * at every injection seam rather than a silently sparse gesture.
 */
type AndroidTransportSamples = readonly [
  PointerTrajectorySample,
  PointerTrajectorySample,
  PointerTrajectorySample,
  ...PointerTrajectorySample[],
];

type AndroidTransportSinglePointerTrajectory = {
  pointerId: 0;
  samples: AndroidTransportSamples;
};

export type AndroidTransportSinglePointerGesturePlan = Omit<
  SinglePointerGesturePlan,
  'pointers'
> & {
  pointers: readonly [AndroidTransportSinglePointerTrajectory];
};

export type AndroidTransportGesturePlan =
  | AndroidTransportSinglePointerGesturePlan
  | MultiTouchGesturePlan;

export type AndroidLoweredTouchPlan = AndroidTransportGesturePlan | AndroidLongPressTouchPlan;

export type AndroidProviderTouchPlan =
  | AndroidTransportGesturePlan
  | (AndroidLongPressTouchPlan & { viewport: Rect });

export function lowerAndroidTouchPlan(plan: AndroidTouchPlan): AndroidLoweredTouchPlan {
  if (plan.topology === 'two' || plan.intent === 'longPress') return plan;

  const [
    {
      pointerId,
      samples: [start, end],
    },
  ] = plan.pointers;
  const dense = sampleGestureOffsets(plan.durationMs, 'android').map((offsetMs) => ({
    offsetMs,
    point: interpolateGesturePoint(start.point, end.point, offsetMs / plan.durationMs),
  }));
  // The sampler floors the frame count at three, so `dense` always holds at least four samples.
  const samples: AndroidTransportSamples = [dense[0]!, dense[1]!, dense[2]!, ...dense.slice(3)];

  return {
    ...plan,
    pointers: [{ pointerId, samples }],
  };
}
