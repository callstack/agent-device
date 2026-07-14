import type { Point } from '../kernel/snapshot.ts';
import { AppError } from '../kernel/errors.ts';
import { gestureDirectionDelta } from './scroll-gesture.ts';
import { readGesturePayload, type GesturePayload } from './gesture-input.ts';
import { GESTURE_FLING_DEFAULT_DISTANCE } from './gesture-plan.ts';
import type { GestureSemanticInput } from './gesture-plan-types.ts';

export type GestureCompatibilityRule = 'swipe-duration' | 'fling-duration' | 'rotate-velocity';

export type GestureDeprecation = {
  rule: GestureCompatibilityRule;
  replacement: string;
};

export type NormalizedPublicGesture = {
  gesture: GestureSemanticInput;
  deprecations: GestureDeprecation[];
};

export type SwipePayload = {
  from: Point;
  to: Point;
  durationMs?: number;
  count?: number;
  pauseMs?: number;
  pattern?: 'one-way' | 'ping-pong';
};

/** The explicit parser for the public CLI and `.ad` gesture syntax. */
// fallow-ignore-next-line complexity
export function gesturePayloadFromPositionals(
  positionals: string[],
  pointerCount?: number,
): GesturePayload {
  const kind = positionals[0];
  const args = positionals.slice(1);
  switch (kind) {
    case 'pan':
      return readGesturePayload({
        kind,
        origin: { x: Number(args[0]), y: Number(args[1]) },
        delta: { x: Number(args[2]), y: Number(args[3]) },
        pointerCount,
        durationMs: optionalPositionNumber(args[4]),
      });
    case 'fling':
      return readGesturePayload({
        kind,
        direction: args[0],
        origin: { x: Number(args[1]), y: Number(args[2]) },
        distance: optionalPositionNumber(args[3]),
        durationMs: optionalPositionNumber(args[4]),
      });
    case 'swipe':
      return readGesturePayload({
        kind,
        preset: args[0],
        durationMs: optionalPositionNumber(args[1]),
      });
    case 'pinch':
      return readGesturePayload({
        kind,
        scale: Number(args[0]),
        origin: optionalOrigin(args[1], args[2]),
      });
    case 'rotate':
      return readGesturePayload({
        kind,
        degrees: Number(args[0]),
        origin: optionalOrigin(args[1], args[2]),
        velocity: optionalPositionNumber(args[3]),
      });
    case 'transform':
      return readGesturePayload({
        kind,
        origin: { x: Number(args[0]), y: Number(args[1]) },
        delta: { x: Number(args[2]), y: Number(args[3]) },
        scale: Number(args[4]),
        degrees: Number(args[5]),
        durationMs: optionalPositionNumber(args[6]),
      });
    default:
      return readGesturePayload({ kind });
  }
}

/** Serializes structured gesture input for `.ad` recordings. */
export function gesturePayloadToPositionals(input: GesturePayload): string[] {
  switch (input.kind) {
    case 'pan':
      return compact([
        input.kind,
        input.origin.x,
        input.origin.y,
        input.delta.x,
        input.delta.y,
        input.durationMs,
      ]);
    case 'fling':
      // `.ad` positionals cannot encode an empty distance slot. Preserve the
      // planner default when a deprecated duration must occupy the next slot.
      return compact([
        input.kind,
        input.direction,
        input.origin.x,
        input.origin.y,
        input.durationMs === undefined
          ? input.distance
          : (input.distance ?? GESTURE_FLING_DEFAULT_DISTANCE),
        input.durationMs,
      ]);
    case 'swipe':
      return compact([input.kind, input.preset, input.durationMs]);
    case 'pinch':
      return compact([input.kind, input.scale, input.origin?.x, input.origin?.y]);
    case 'rotate':
      return input.origin
        ? compact([input.kind, input.degrees, input.origin.x, input.origin.y, input.velocity])
        : [input.kind, String(input.degrees)];
    case 'transform':
      return compact([
        input.kind,
        input.origin.x,
        input.origin.y,
        input.delta.x,
        input.delta.y,
        input.scale,
        input.degrees,
        input.durationMs,
      ]);
  }
}

/** Parses the public CLI and `.ad` coordinate-swipe syntax. */
export function swipePayloadFromPositionals(
  positionals: string[],
  options: Omit<SwipePayload, 'from' | 'to' | 'durationMs'> = {},
): SwipePayload {
  return {
    from: { x: Number(positionals[0]), y: Number(positionals[1]) },
    to: { x: Number(positionals[2]), y: Number(positionals[3]) },
    ...(positionals[4] === undefined ? {} : { durationMs: Number(positionals[4]) }),
    ...(options.count === undefined ? {} : { count: options.count }),
    ...(options.pauseMs === undefined ? {} : { pauseMs: options.pauseMs }),
    ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
  };
}

/** The only public/deprecated gesture interpretation point. */
export function normalizePublicGesture(input: GesturePayload): NormalizedPublicGesture {
  switch (input.kind) {
    case 'pan':
      return {
        gesture: {
          intent: 'pan',
          origin: input.origin,
          delta: input.delta,
          pointerCount: input.pointerCount,
          durationMs: input.durationMs,
        },
        deprecations: [],
      };
    case 'fling': {
      if (input.durationMs !== undefined) {
        return {
          gesture: {
            intent: 'pan',
            origin: input.origin,
            delta: gestureDirectionDelta(
              input.direction,
              input.distance ?? GESTURE_FLING_DEFAULT_DISTANCE,
            ),
            durationMs: input.durationMs,
            executionProfile: 'endpoint-hold',
          },
          deprecations: [
            { rule: 'fling-duration', replacement: 'Use gesture pan for timed movement.' },
          ],
        };
      }
      return {
        gesture: {
          intent: 'fling',
          direction: input.direction,
          origin: input.origin,
          distance: input.distance,
        },
        deprecations: [],
      };
    }
    case 'swipe':
      return input.durationMs === undefined
        ? { gesture: { intent: 'fling', preset: input.preset }, deprecations: [] }
        : {
            gesture: {
              intent: 'pan',
              preset: input.preset,
              durationMs: input.durationMs,
              executionProfile: 'endpoint-hold',
            },
            deprecations: [
              { rule: 'swipe-duration', replacement: 'Use gesture pan for timed movement.' },
            ],
          };
    case 'pinch':
      return {
        gesture: { intent: 'pinch', origin: input.origin, scale: input.scale },
        deprecations: [],
      };
    case 'rotate':
      return {
        gesture: { intent: 'rotate', origin: input.origin, degrees: input.degrees },
        deprecations:
          input.velocity === undefined
            ? []
            : [
                {
                  rule: 'rotate-velocity',
                  replacement: 'Rotation pacing is derived from degrees.',
                },
              ],
      };
    case 'transform':
      return {
        gesture: {
          intent: 'transform',
          origin: input.origin,
          delta: input.delta,
          scale: input.scale,
          degrees: input.degrees,
          durationMs: input.durationMs,
        },
        deprecations: [],
      };
  }
}

export function normalizePublicSwipeMotion(input: {
  from: Point;
  to: Point;
  durationMs?: number;
}): NormalizedPublicGesture {
  if (input.durationMs === undefined) {
    return {
      gesture: { intent: 'fling', from: input.from, to: input.to },
      deprecations: [],
    };
  }
  return {
    gesture: {
      intent: 'pan',
      origin: input.from,
      delta: { x: input.to.x - input.from.x, y: input.to.y - input.from.y },
      durationMs: input.durationMs,
      executionProfile: 'endpoint-hold',
    },
    deprecations: [{ rule: 'swipe-duration', replacement: 'Use gesture pan for timed movement.' }],
  };
}

function optionalPositionNumber(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function optionalOrigin(x: string | undefined, y: string | undefined): Point | undefined {
  if ((x === undefined) !== (y === undefined)) {
    throw new AppError('INVALID_ARGS', 'gesture origin requires both x and y coordinates');
  }
  return x === undefined ? undefined : { x: Number(x), y: Number(y) };
}

function compact(values: Array<string | number | undefined>): string[] {
  return values.filter((value): value is string | number => value !== undefined).map(String);
}
