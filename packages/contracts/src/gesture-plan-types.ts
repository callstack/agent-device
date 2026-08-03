import type { Point, Rect } from '@agent-device/kernel/snapshot';
import type { ScrollDirection, SwipePreset } from './scroll-gesture.ts';

export type GesturePointerCount = 1 | 2;

export const GESTURE_DURATION_MIN_MS = 16;
export const GESTURE_DURATION_MAX_MS = 10_000;
export const DEFAULT_DRAG_SOURCE_HOLD_MS = 800;
export const DEFAULT_DRAG_MOVE_MS = 500;
export const DEFAULT_DRAG_DESTINATION_HOLD_MS = 0;

export type GestureIntent = 'fling' | 'pan' | 'pinch' | 'rotate' | 'transform';

export type DragGestureInput = {
  intent: 'drag';
  source: string;
  destination: string;
  sourceHoldMs?: number;
  moveMs?: number;
  destinationHoldMs?: number;
};

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

export type GestureCommandInput = GestureSemanticInput | DragGestureInput;

export type PointerTrajectorySample = { offsetMs: number; point: Point };

export type PointerTrajectory = {
  pointerId: 0 | 1;
  samples: readonly PointerTrajectorySample[];
};

export type SinglePointerTrajectory = {
  pointerId: 0;
  samples: readonly [
    PointerTrajectorySample,
    PointerTrajectorySample,
    ...PointerTrajectorySample[],
  ];
};

export type SinglePointerGesturePlan = {
  topology: 'single';
  intent: 'fling' | 'pan';
  executionProfile: GestureExecutionProfile;
  durationMs: number;
  viewport: Rect;
  pointers: readonly [SinglePointerTrajectory];
};

export type MultiTouchGesturePlan = {
  topology: 'two';
  intent: 'pan' | 'pinch' | 'rotate' | 'transform';
  durationMs: number;
  viewport: Rect;
  pointers: readonly [PointerTrajectory, PointerTrajectory];
};

export type GesturePlan = SinglePointerGesturePlan | MultiTouchGesturePlan;
