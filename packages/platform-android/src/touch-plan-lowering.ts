import type { ScrollReleaseBehavior } from '@agent-device/contracts/scroll-command';
import {
  GESTURE_SAMPLE_INTERVAL_MS,
  densifyGesturePath,
} from '@agent-device/contracts/gesture-plan';
import type {
  GesturePlan,
  MultiTouchGesturePlan,
  PointerTrajectory,
  PointerTrajectorySample,
  SinglePointerGesturePlan,
} from '@agent-device/contracts/gesture-plan-types';
import type { Rect } from '@agent-device/kernel/snapshot';

export type AndroidLongPressTouchPlan = {
  topology: 'single';
  intent: 'longPress';
  durationMs: number;
  pointers: readonly [PointerTrajectory];
};

export type AndroidTouchPlan =
  | (GesturePlan & { releaseBehavior?: ScrollReleaseBehavior })
  | AndroidLongPressTouchPlan;

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
  if (plan.topology !== 'single' || plan.intent === 'longPress') return plan;

  const { releaseBehavior, ...gesturePlan } = plan;
  const [{ pointerId, samples: canonicalSamples }] = gesturePlan.pointers;
  const dense = densifyGesturePath(canonicalSamples, 'android', (progress, segmentDurationMs) =>
    releaseBehavior === 'controlled'
      ? controlledScrollProgress(progress, segmentDurationMs)
      : progress,
  );
  // The sampler floors the frame count at three, so `dense` always holds at least four samples.
  const samples: AndroidTransportSamples = [dense[0]!, dense[1]!, dense[2]!, ...dense.slice(3)];

  return {
    ...gesturePlan,
    pointers: [{ pointerId, samples }],
  };
}

function controlledScrollProgress(progress: number, durationMs: number): number {
  const accelerationFraction = Math.min(GESTURE_SAMPLE_INTERVAL_MS / durationMs, 0.5);
  return progress < accelerationFraction
    ? progress ** 2 / accelerationFraction
    : 1 - (1 - progress) ** 2 / (1 - accelerationFraction);
}
