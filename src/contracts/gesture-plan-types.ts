import type { Point, Rect } from '../kernel/snapshot.ts';
import type { ScrollDirection, SwipePreset } from './scroll-gesture.ts';

export type GesturePointerCount = 1 | 2;

export type GestureIntent = 'swipe' | 'pan' | 'fling' | 'pinch' | 'rotate' | 'transform';

export type GestureSemanticInput =
  | { intent: 'swipe'; preset: SwipePreset; durationMs?: number }
  | { intent: 'swipe'; from: Point; to: Point; durationMs?: number }
  | {
      intent: 'pan';
      origin: Point;
      delta: Point;
      pointerCount?: GesturePointerCount;
      durationMs?: number;
    }
  | {
      intent: 'fling';
      direction: ScrollDirection;
      origin: Point;
      distance?: number;
      durationMs?: number;
    }
  | { intent: 'pinch'; origin?: Point; scale: number }
  | { intent: 'rotate'; origin?: Point; degrees: number; velocity?: number }
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
  intent: 'swipe' | 'pan' | 'fling';
  durationMs: number;
  pointers: readonly [PointerTrajectory];
};

export type MultiTouchGesturePlan = {
  topology: 'two';
  intent: 'pan' | 'pinch' | 'rotate' | 'transform';
  durationMs: number;
  viewport: Rect;
  centroid: { start: Point; end: Point };
  scale: number;
  rotationDegrees: number;
  velocity?: number;
  initialSpan: number;
  initialAngleDegrees: number;
  pointers: readonly [PointerTrajectory, PointerTrajectory];
};

export type GesturePlan = SinglePointerGesturePlan | MultiTouchGesturePlan;
