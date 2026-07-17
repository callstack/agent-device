import type { Point, Rect } from '../kernel/snapshot.ts';
import type { ScrollDirection, SwipePreset } from './scroll-gesture.ts';

export type GesturePointerCount = 1 | 2;

export const GESTURE_DURATION_MIN_MS = 16;
export const GESTURE_DURATION_MAX_MS = 10_000;

export type GestureIntent = 'fling' | 'pan' | 'pinch' | 'rotate' | 'transform';

/** Selects one-pointer release timing without changing semantic gesture intent. */
export type GestureExecutionProfile = 'endpoint-hold' | 'timed-pan';

export type GestureSemanticInput =
  | { intent: 'fling'; from: Point; to: Point }
  | { intent: 'fling'; preset: SwipePreset }
  | {
      intent: 'fling';
      direction: ScrollDirection;
      origin: Point;
      distance?: number;
    }
  | {
      intent: 'pan';
      origin: Point;
      delta: Point;
      pointerCount?: GesturePointerCount;
      durationMs?: number;
      executionProfile?: GestureExecutionProfile;
    }
  | { intent: 'pinch'; origin?: Point; scale: number }
  | { intent: 'rotate'; origin?: Point; degrees: number }
  | {
      intent: 'transform';
      origin: Point;
      delta: Point;
      scale: number;
      degrees: number;
      durationMs?: number;
    };

export type PointerTrajectorySample = { offsetMs: number; point: Point };

export type PointerTrajectory = {
  pointerId: 0 | 1;
  samples: readonly PointerTrajectorySample[];
};

export type SinglePointerGesturePlan = {
  topology: 'single';
  intent: 'fling' | 'pan';
  executionProfile: GestureExecutionProfile;
  durationMs: number;
  viewport: Rect;
  pointers: readonly [PointerTrajectory];
};

export type MultiTouchGesturePlan = {
  topology: 'two';
  intent: 'pan' | 'pinch' | 'rotate' | 'transform';
  durationMs: number;
  viewport: Rect;
  pointers: readonly [PointerTrajectory, PointerTrajectory];
};

export type GesturePlan = SinglePointerGesturePlan | MultiTouchGesturePlan;
