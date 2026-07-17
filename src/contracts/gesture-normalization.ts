import type { Point } from '../kernel/snapshot.ts';
import { AppError } from '../kernel/errors.ts';
import { readGesturePayload, type GesturePayload } from './gesture-input.ts';
import type { GestureSemanticInput } from './gesture-plan-types.ts';

export type NormalizedPublicGesture = {
  gesture: GestureSemanticInput;
};

export type SwipePayload = {
  from: Point;
  to: Point;
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
    case 'pan': {
      if (args.length > 5) {
        throw new AppError(
          'INVALID_ARGS',
          'gesture pan accepts at most 5 arguments: x y dx dy [durationMs]',
        );
      }
      return readGesturePayload({
        kind,
        origin: { x: Number(args[0]), y: Number(args[1]) },
        delta: { x: Number(args[2]), y: Number(args[3]) },
        pointerCount,
        durationMs: optionalPositionNumber(args[4]),
      });
    }
    case 'fling': {
      if (args.length > 4) {
        throw new AppError(
          'INVALID_ARGS',
          'gesture fling accepts at most 4 arguments: direction x y [distance]; for timed movement use gesture pan',
        );
      }
      return readGesturePayload({
        kind,
        direction: args[0],
        origin: { x: Number(args[1]), y: Number(args[2]) },
        distance: optionalPositionNumber(args[3]),
      });
    }
    case 'swipe': {
      if (args.length > 1) {
        throw new AppError(
          'INVALID_ARGS',
          'gesture swipe accepts 1 argument: preset; for timed movement use gesture pan',
        );
      }
      return readGesturePayload({
        kind,
        preset: args[0],
      });
    }
    case 'pinch': {
      if (args.length > 3) {
        throw new AppError(
          'INVALID_ARGS',
          'gesture pinch accepts at most 3 arguments: scale [x] [y]',
        );
      }
      return readGesturePayload({
        kind,
        scale: Number(args[0]),
        origin: optionalOrigin(args[1], args[2]),
      });
    }
    case 'rotate': {
      if (args.length > 3) {
        throw new AppError(
          'INVALID_ARGS',
          'gesture rotate accepts at most 3 arguments: degrees [x] [y]',
        );
      }
      return readGesturePayload({
        kind,
        degrees: Number(args[0]),
        origin: optionalOrigin(args[1], args[2]),
      });
    }
    case 'transform': {
      if (args.length > 7) {
        throw new AppError(
          'INVALID_ARGS',
          'gesture transform accepts at most 7 arguments: x y dx dy scale degrees [durationMs]',
        );
      }
      return readGesturePayload({
        kind,
        origin: { x: Number(args[0]), y: Number(args[1]) },
        delta: { x: Number(args[2]), y: Number(args[3]) },
        scale: Number(args[4]),
        degrees: Number(args[5]),
        durationMs: optionalPositionNumber(args[6]),
      });
    }
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
      return compact([input.kind, input.direction, input.origin.x, input.origin.y, input.distance]);
    case 'swipe':
      return [input.kind, input.preset];
    case 'pinch':
      return compact([input.kind, input.scale, input.origin?.x, input.origin?.y]);
    case 'rotate':
      return input.origin
        ? compact([input.kind, input.degrees, input.origin.x, input.origin.y])
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
  options: Omit<SwipePayload, 'from' | 'to'> = {},
): SwipePayload {
  if (positionals.length > 4) {
    throw new AppError(
      'INVALID_ARGS',
      'swipe accepts 4 arguments: x1 y1 x2 y2; for timed movement use gesture pan',
    );
  }
  return {
    from: { x: Number(positionals[0]), y: Number(positionals[1]) },
    to: { x: Number(positionals[2]), y: Number(positionals[3]) },
    ...(options.count === undefined ? {} : { count: options.count }),
    ...(options.pauseMs === undefined ? {} : { pauseMs: options.pauseMs }),
    ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
  };
}

/** The only public gesture interpretation point. */
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
      };
    case 'fling':
      return {
        gesture: {
          intent: 'fling',
          direction: input.direction,
          origin: input.origin,
          distance: input.distance,
        },
      };
    case 'swipe':
      return { gesture: { intent: 'fling', preset: input.preset } };
    case 'pinch':
      return {
        gesture: { intent: 'pinch', origin: input.origin, scale: input.scale },
      };
    case 'rotate':
      return {
        gesture: { intent: 'rotate', origin: input.origin, degrees: input.degrees },
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
      };
  }
}

export function normalizePublicSwipeMotion(input: {
  from: Point;
  to: Point;
}): NormalizedPublicGesture {
  return {
    gesture: { intent: 'fling', from: input.from, to: input.to },
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
