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

type AndroidTransportSinglePointerTrajectory = {
  pointerId: 0;
  samples: readonly PointerTrajectorySample[];
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
  const samples = sampleGestureOffsets(plan.durationMs, 'android').map((offsetMs) => ({
    offsetMs,
    point: interpolateGesturePoint(start.point, end.point, offsetMs / plan.durationMs),
  }));

  return {
    ...plan,
    pointers: [{ pointerId, samples }],
  };
}
