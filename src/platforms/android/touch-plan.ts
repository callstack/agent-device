import type { GesturePlan, PointerTrajectory } from '../../contracts/gesture-plan.ts';
import type { Rect } from '@agent-device/kernel/snapshot';

export type AndroidLongPressTouchPlan = {
  topology: 'single';
  intent: 'longPress';
  durationMs: number;
  pointers: readonly [PointerTrajectory];
};

export type AndroidTouchPlan = GesturePlan | AndroidLongPressTouchPlan;

export type AndroidProviderTouchPlan =
  | GesturePlan
  | (AndroidLongPressTouchPlan & { viewport: Rect });
