import { AppError } from '../kernel/errors.ts';
import type { Point } from '../kernel/snapshot.ts';
import { readOptionalInteger } from '../kernel/input-validation.ts';
import {
  SCROLL_DIRECTIONS,
  SWIPE_PRESETS,
  type ScrollDirection,
  type SwipePreset,
} from './scroll-gesture.ts';
import {
  GESTURE_DURATION_MAX_MS,
  GESTURE_DURATION_MIN_MS,
  type GesturePointerCount,
} from './gesture-plan-types.ts';

export const GESTURE_KINDS = ['pan', 'fling', 'swipe', 'pinch', 'rotate', 'transform'] as const;

export type PanGesturePayload = {
  kind: 'pan';
  origin: Point;
  delta: Point;
  pointerCount?: GesturePointerCount;
  durationMs?: number;
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

export type GesturePayload =
  | PanGesturePayload
  | FlingGesturePayload
  | SwipeGesturePayload
  | PinchGesturePayload
  | RotateGesturePayload
  | TransformGesturePayload;

export function readGesturePayload(input: unknown): GesturePayload {
  const record = readRecord(input);
  const kind = readEnum(record, 'kind', GESTURE_KINDS);
  if (kind === 'pan') {
    return {
      kind,
      origin: readPoint(record, 'origin'),
      delta: readPoint(record, 'delta'),
      pointerCount: readOptionalInteger(record, 'pointerCount', { min: 1, max: 2 }) as
        | GesturePointerCount
        | undefined,
      durationMs: readOptionalGestureDuration(record),
    };
  }
  if (record.pointerCount !== undefined) {
    throw new AppError('INVALID_ARGS', 'pointerCount is supported only for gesture pan');
  }
  if (kind === 'fling') {
    if (record.durationMs !== undefined) {
      throw new AppError(
        'INVALID_ARGS',
        'gesture fling does not accept durationMs; use gesture pan for timed movement',
      );
    }
    return {
      kind,
      direction: readEnum(record, 'direction', SCROLL_DIRECTIONS),
      origin: readPoint(record, 'origin'),
      distance: readOptionalInteger(record, 'distance', { min: 0 }),
    };
  }
  if (kind === 'swipe') {
    if (record.durationMs !== undefined) {
      throw new AppError(
        'INVALID_ARGS',
        'gesture swipe does not accept durationMs; use gesture pan for timed movement',
      );
    }
    return {
      kind,
      preset: readEnum(record, 'preset', SWIPE_PRESETS),
    };
  }
  if (kind === 'pinch') {
    return {
      kind,
      scale: readNumber(record, 'scale'),
      origin: readOptionalPoint(record, 'origin'),
    };
  }
  if (kind === 'rotate') {
    if (record.velocity !== undefined) {
      throw new AppError(
        'INVALID_ARGS',
        'gesture rotate does not accept velocity; rotation pacing derives from degrees',
      );
    }
    return {
      kind,
      degrees: readNumber(record, 'degrees'),
      origin: readOptionalPoint(record, 'origin'),
    };
  }
  return {
    kind,
    origin: readPoint(record, 'origin'),
    delta: readPoint(record, 'delta'),
    scale: readNumber(record, 'scale'),
    degrees: readNumber(record, 'degrees'),
    durationMs: readOptionalGestureDuration(record),
  };
}

function readOptionalGestureDuration(record: Record<string, unknown>): number | undefined {
  const durationMs = readOptionalInteger(record, 'durationMs');
  if (durationMs === undefined) return undefined;
  if (durationMs < GESTURE_DURATION_MIN_MS || durationMs > GESTURE_DURATION_MAX_MS) {
    throw new AppError(
      'INVALID_ARGS',
      `Expected durationMs to be an integer between ${GESTURE_DURATION_MIN_MS} and ${GESTURE_DURATION_MAX_MS}.`,
    );
  }
  return durationMs;
}

function readRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_ARGS', 'gesture requires structured object input');
  }
  return input as Record<string, unknown>;
}

function readPoint(record: Record<string, unknown>, key: string): Point {
  const point = readRecord(record[key]);
  return { x: readNumber(point, 'x'), y: readNumber(point, 'y') };
}

function readOptionalPoint(record: Record<string, unknown>, key: string): Point | undefined {
  return record[key] === undefined ? undefined : readPoint(record, key);
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be a finite number.`);
  }
  return value;
}

function readEnum<const Values extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: Values,
): Values[number] {
  const value = record[key];
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be one of: ${values.join(', ')}.`);
  }
  return value;
}
