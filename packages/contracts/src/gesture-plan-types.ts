import type { Point, Rect } from '@agent-device/kernel/snapshot';
import type { ScrollDirection, SwipePreset } from './scroll-gesture.ts';

export type GesturePointerCount = 1 | 2;

/**
 * The most simultaneous contacts any plan carries. The iOS runner and the Android helper each
 * mirror this cap in their own plan validation.
 */
export const GESTURE_MAX_CONTACTS = 5;
export const GESTURE_TAP_MIN_CONTACTS = 2;
export const DEFAULT_TAP_HOLD_MS = 50;
/** Contacts one gesture held at once, as reported back to the caller. */
export type GestureContactCount = 1 | 2 | 3 | 4 | 5;

export const GESTURE_DURATION_MIN_MS = 16;
export const GESTURE_DURATION_MAX_MS = 10_000;
export const DEFAULT_DRAG_SOURCE_HOLD_MS = 800;
export const DEFAULT_DRAG_MOVE_MS = 500;
export const DEFAULT_DRAG_DESTINATION_HOLD_MS = 0;

export type GestureIntent = 'fling' | 'pan' | 'pinch' | 'rotate' | 'transform' | 'tap';

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
    }
  | {
      intent: 'tap';
      points: readonly Point[];
      holdMs?: number;
    };

export type GestureCommandInput = GestureSemanticInput | DragGestureInput;

export type PointerTrajectorySample = { offsetMs: number; point: Point };

export type TapPointerId = 0 | 1 | 2 | 3 | 4;

export type PointerTrajectory<PointerId extends number = 0 | 1> = {
  pointerId: PointerId;
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

export type TwoContactGesturePlan = {
  topology: 'multi';
  intent: 'pan' | 'pinch' | 'rotate' | 'transform';
  durationMs: number;
  viewport: Rect;
  pointers: readonly [PointerTrajectory, PointerTrajectory];
};

/** Stationary contacts that touch down together and lift together after `durationMs`. */
export type TapGesturePlan = {
  topology: 'multi';
  intent: 'tap';
  durationMs: number;
  viewport: Rect;
  pointers: readonly [
    PointerTrajectory<TapPointerId>,
    PointerTrajectory<TapPointerId>,
    ...PointerTrajectory<TapPointerId>[],
  ];
};

export type MultiTouchGesturePlan = TwoContactGesturePlan | TapGesturePlan;

export type GesturePlan = SinglePointerGesturePlan | MultiTouchGesturePlan;
