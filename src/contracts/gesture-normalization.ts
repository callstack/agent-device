import type { Point } from '../kernel/snapshot.ts';
import type { SwipePreset } from './scroll-gesture.ts';
import { readGesturePayload, type GesturePayload } from './gesture-input.ts';
import type { GestureSemanticInput } from './gesture-plan-types.ts';

export type GestureCompatibilityRule = 'swipe-duration' | 'fling-duration' | 'rotate-velocity';

export type GestureDeprecation = {
  rule: GestureCompatibilityRule;
  replacement: string;
};

export type NormalizedGestureInput =
  | GestureSemanticInput
  | { intent: 'fling'; preset: SwipePreset }
  | { intent: 'pan'; preset: SwipePreset; durationMs: number };

export type NormalizedPublicGesture = {
  gesture: NormalizedGestureInput;
  deprecations: GestureDeprecation[];
};

/** The explicit compatibility parser for legacy CLI/.ad gesture positionals. */
// fallow-ignore-next-line complexity
export function gesturePayloadFromLegacyPositionals(
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
            delta: directionDelta(input.direction, input.distance ?? 180),
            durationMs: input.durationMs,
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
            gesture: { intent: 'pan', preset: input.preset, durationMs: input.durationMs },
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
    },
    deprecations: [{ rule: 'swipe-duration', replacement: 'Use gesture pan for timed movement.' }],
  };
}

export function normalizePublicSwipePreset(input: {
  preset: SwipePreset;
  durationMs?: number;
}): NormalizedPublicGesture {
  return normalizePublicGesture({ kind: 'swipe', ...input });
}

function directionDelta(direction: 'up' | 'down' | 'left' | 'right', distance: number): Point {
  switch (direction) {
    case 'up':
      return { x: 0, y: -distance };
    case 'down':
      return { x: 0, y: distance };
    case 'left':
      return { x: -distance, y: 0 };
    case 'right':
      return { x: distance, y: 0 };
  }
}

function optionalPositionNumber(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function optionalOrigin(x: string | undefined, y: string | undefined): Point | undefined {
  return x === undefined || y === undefined ? undefined : { x: Number(x), y: Number(y) };
}
