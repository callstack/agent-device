import type { GesturePlan, PointerTrajectory } from '../../contracts/gesture-plan.ts';
import type { Rect } from '../../kernel/snapshot.ts';

export type AndroidLongPressTouchPlan = {
  topology: 'single';
  intent: 'longPress';
  durationMs: number;
  viewport: Rect;
  pointers: readonly [PointerTrajectory];
};

export type AndroidTouchPlan = GesturePlan | AndroidLongPressTouchPlan;
