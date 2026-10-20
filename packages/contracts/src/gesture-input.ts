import { AppError } from '@agent-device/kernel/errors';
import type { Point } from '@agent-device/kernel/snapshot';
import { readOptionalInteger } from './input-validation.ts';
import {
  SCROLL_DIRECTIONS,
  SWIPE_PAUSE_MAX_MS,
  SWIPE_PRESETS,
  SWIPE_REPETITION_MAX,
  SWIPE_SERIES_MAX_SCHEDULED_DURATION_MS,
  type ScrollDirection,
  type SwipePreset,
} from './scroll-gesture.ts';
import {
  DEFAULT_DRAG_DESTINATION_HOLD_MS,
  DEFAULT_DRAG_MOVE_MS,
  DEFAULT_DRAG_SOURCE_HOLD_MS,
  DEFAULT_TAP_HOLD_MS,
  GESTURE_DURATION_MAX_MS,
  GESTURE_DURATION_MIN_MS,
  GESTURE_MAX_CONTACTS,
  GESTURE_TAP_MIN_CONTACTS,
  type GesturePointerCount,
} from './gesture-plan-types.ts';

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

/**
 * Per-iteration time a tap series budgets beyond its hold and pause: a whole repetition measured
 * about 450 ms on a physical iPhone, about 320 ms of it inside the multi-touch synthesis.
 */
const TAP_SERIES_OVERHEAD_ALLOWANCE_MS = 500;

const TAP_ONLY_FIELDS = ['points', 'holdMs', 'count', 'pauseMs'] as const;

export function readGesturePayload(input: unknown): GesturePayload {
  const record = readRecord(input);
  const kind = readEnum(record, 'kind', GESTURE_KINDS);
  if (kind === 'tap') {
    return readTapGesturePayload(record);
  }
  assertNoTapOnlyFields(kind, record);
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
  if (kind === 'drag') {
    return readDragGesturePayload(record);
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

function readTapGesturePayload(record: Record<string, unknown>): TapGesturePayload {
  if (record.pointerCount !== undefined) {
    throw new AppError('INVALID_ARGS', 'pointerCount is supported only for gesture pan', {
      hint: 'gesture tap takes one contact per point.',
    });
  }
  if (record.durationMs !== undefined) {
    throw new AppError('INVALID_ARGS', 'gesture tap does not accept durationMs; use holdMs');
  }
  const payload: TapGesturePayload = {
    kind: 'tap',
    points: readTapPoints(record),
    holdMs: readOptionalInteger(record, 'holdMs', {
      min: GESTURE_DURATION_MIN_MS,
      max: GESTURE_DURATION_MAX_MS,
    }),
    count: readOptionalInteger(record, 'count', { min: 1, max: SWIPE_REPETITION_MAX }),
    pauseMs: readOptionalInteger(record, 'pauseMs', { min: 0, max: SWIPE_PAUSE_MAX_MS }),
  };
  assertTapSeriesFitsRequest(payload);
  return payload;
}

function readTapPoints(record: Record<string, unknown>): Point[] {
  const points = record.points;
  if (
    !Array.isArray(points) ||
    points.length < GESTURE_TAP_MIN_CONTACTS ||
    points.length > GESTURE_MAX_CONTACTS
  ) {
    throw new AppError(
      'INVALID_ARGS',
      `gesture tap requires ${GESTURE_TAP_MIN_CONTACTS} to ${GESTURE_MAX_CONTACTS} points`,
      { hint: 'Use press for a single contact.' },
    );
  }
  return points.map((value: unknown, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AppError('INVALID_ARGS', `Expected points[${index}] to be a point.`);
    }
    const point = value as Record<string, unknown>;
    return { x: readNumber(point, 'x'), y: readNumber(point, 'y') };
  });
}

/**
 * The series has to finish inside the daemon request envelope. Each iteration costs its hold and
 * pause plus a fixed synthesis overhead the hold does not include.
 */
function assertTapSeriesFitsRequest(input: TapGesturePayload): void {
  const count = input.count ?? 1;
  const pauseMs = input.pauseMs ?? 0;
  const holdMs = input.holdMs ?? DEFAULT_TAP_HOLD_MS;
  const scheduledDurationMs =
    count * (holdMs + TAP_SERIES_OVERHEAD_ALLOWANCE_MS) + Math.max(0, count - 1) * pauseMs;
  if (scheduledDurationMs <= SWIPE_SERIES_MAX_SCHEDULED_DURATION_MS) return;
  throw new AppError(
    'INVALID_ARGS',
    `gesture tap series must fit within ${SWIPE_SERIES_MAX_SCHEDULED_DURATION_MS}ms.`,
    {
      count,
      pauseMs,
      holdMs,
      overheadAllowanceMs: TAP_SERIES_OVERHEAD_ALLOWANCE_MS,
      scheduledDurationMs,
      hint: 'Reduce --count, --pause-ms or --hold-ms.',
    },
  );
}

function assertNoTapOnlyFields(kind: string, record: Record<string, unknown>): void {
  const field = TAP_ONLY_FIELDS.find((key) => record[key] !== undefined);
  if (field === undefined) return;
  throw new AppError('INVALID_ARGS', `${field} is supported only for gesture tap`, {
    hint: `gesture ${kind} does not read ${field}.`,
  });
}

function readDragGesturePayload(record: Record<string, unknown>): DragGesturePayload {
  const sourceHoldMs = readOptionalInteger(record, 'sourceHoldMs', { min: 1, max: 10_000 });
  const moveMs = readOptionalInteger(record, 'moveMs', { min: 16, max: 10_000 });
  const destinationHoldMs = readOptionalInteger(record, 'destinationHoldMs', {
    // Releasing immediately at the destination is valid; activating a drag
    // at the source requires a positive hold.
    min: 0,
    max: 10_000,
  });
  const totalDurationMs =
    (sourceHoldMs ?? DEFAULT_DRAG_SOURCE_HOLD_MS) +
    (moveMs ?? DEFAULT_DRAG_MOVE_MS) +
    (destinationHoldMs ?? DEFAULT_DRAG_DESTINATION_HOLD_MS);
  if (totalDurationMs > GESTURE_DURATION_MAX_MS) {
    throw new AppError(
      'INVALID_ARGS',
      `gesture drag total duration must be at most ${GESTURE_DURATION_MAX_MS}`,
    );
  }
  return {
    kind: 'drag',
    source: readNonEmptyString(record, 'source'),
    destination: readNonEmptyString(record, 'destination'),
    sourceHoldMs,
    moveMs,
    destinationHoldMs,
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

function readNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be a non-empty string.`);
  }
  return value.trim();
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
