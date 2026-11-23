import type { Point } from '@agent-device/kernel/snapshot';
import type { ScrollDirection, SwipePreset } from './scroll-gesture.ts';
import type { GesturePointerCount } from './gesture-plan-types.ts';

export const COORDINATE_GESTURE_KINDS = [
  'pan',
  'fling',
  'swipe',
  'pinch',
  'rotate',
  'transform',
  'tap',
] as const;
export const GESTURE_KINDS = [...COORDINATE_GESTURE_KINDS, 'drag'] as const;

export type DragGesturePayload = {
  kind: 'drag';
  source: string;
  destination: string;
  sourceHoldMs?: number;
  moveMs?: number;
  destinationHoldMs?: number;
};

export type PanGesturePayload = {
  kind: 'pan';
  origin: Point;
  delta: Point;
  pointerCount?: GesturePointerCount;
  durationMs?: number;
  /** Hold the contact at the origin this long before the move starts. */
  holdMs?: number;
};

export type FlingGesturePayload = {
  kind: 'fling';
  direction: ScrollDirection;
  origin: Point;
  distance?: number;
};

export type SwipeGesturePayload = {
  kind: 'swipe';
  preset: SwipePreset;
};

export type PinchGesturePayload = {
  kind: 'pinch';
  scale: number;
  origin?: Point;
  /** A `@ref` or selector the pinch centers on, in place of `origin`. */
  element?: string;
};

export type RotateGesturePayload = {
  kind: 'rotate';
  degrees: number;
  origin?: Point;
};

export type TransformGesturePayload = {
  kind: 'transform';
  origin: Point;
  delta: Point;
  scale: number;
  degrees: number;
  durationMs?: number;
};

export type TapGesturePayload = {
  kind: 'tap';
  points: Point[];
  holdMs?: number;
  count?: number;
  pauseMs?: number;
};

export type GesturePayload =
  | PanGesturePayload
  | FlingGesturePayload
  | SwipeGesturePayload
  | PinchGesturePayload
  | RotateGesturePayload
  | TransformGesturePayload
  | TapGesturePayload
  | DragGesturePayload;
