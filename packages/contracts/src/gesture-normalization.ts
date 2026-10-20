import type { Point } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import { readGesturePayload, type GESTURE_KINDS, type GesturePayload } from './gesture-input.ts';
import type { GestureCommandInput, GestureSemanticInput } from './gesture-plan-types.ts';
import {
  DEFAULT_DRAG_DESTINATION_HOLD_MS,
  DEFAULT_DRAG_MOVE_MS,
  DEFAULT_DRAG_SOURCE_HOLD_MS,
} from './gesture-plan-types.ts';

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

type GestureFlagKey = 'pointerCount' | 'holdMs' | 'count' | 'pauseMs';

const GESTURE_FLAG_NAMES: Record<GestureFlagKey, string> = {
  pointerCount: '--pointer-count',
  holdMs: '--hold-ms',
  count: '--count',
  pauseMs: '--pause-ms',
};

/**
 * Which flag-carried inputs each gesture kind reads. The CLI parser refuses the rest through
 * `flagsByAction`, and the `.ad` preflight refuses them here, so a script cannot carry a flag the
 * CLI would reject and have it silently dropped.
 */
export const GESTURE_FLAGS_BY_KIND = {
  pan: ['pointerCount'],
  tap: ['holdMs', 'count', 'pauseMs'],
  fling: [],
  swipe: [],
  pinch: [],
  rotate: [],
  transform: [],
  drag: [],
} as const satisfies Record<(typeof GESTURE_KINDS)[number], readonly GestureFlagKey[]>;

/** The `.ad` refusal for a gesture line that carries a flag its kind does not read. */
export function describeReplayGestureFlagError(
  command: string,
  positionals: readonly string[],
  flags: Partial<Record<GestureFlagKey, unknown>>,
  source: string,
): string | undefined {
  if (command !== 'gesture') return undefined;
  const kind = positionals[0];
  if (kind === undefined || !Object.hasOwn(GESTURE_FLAGS_BY_KIND, kind)) return undefined;
  const reads: readonly GestureFlagKey[] =
    GESTURE_FLAGS_BY_KIND[kind as keyof typeof GESTURE_FLAGS_BY_KIND];
  const unread = (Object.keys(GESTURE_FLAG_NAMES) as GestureFlagKey[]).filter(
    (key) => flags[key] !== undefined && !reads.includes(key),
  );
  if (unread.length === 0) return undefined;
  const names = unread.map((key) => GESTURE_FLAG_NAMES[key]).join(', ');
  return `gesture ${kind} does not read ${names} (${source}).`;
}

/** Derived from the canonical kinds, so a new gesture kind cannot skip the arity table. */
type GestureSyntaxKey = 'swipe' | `gesture ${(typeof GESTURE_KINDS)[number]}`;

type PublicGestureSyntax = {
  /** Highest accepted positional count, flags excluded. */
  max: number;
  /** Lowest accepted positional count, when a syntax has no optional tail below it. */
  min?: number;
  /** Positionals come in x/y pairs, so an odd count is refused. */
  pairs?: true;
  usage: string;
  /**
   * The trailing positional this syntax used to accept and no longer does. One
   * extra numeric argument reports its migration instead of a bare usage line,
   * which is what a saved recording or hand-written `.ad` from before the
   * removal actually carries.
   */
  retired?: {
    positional: string;
    migrate: (args: readonly string[], canonical: string) => string;
  };
};

/**
 * The positional arity of every public gesture syntax, in one table so the CLI
 * argv parse and the `.ad` script preflight reject the same shapes and report
 * the same migration.
 */
const PUBLIC_GESTURE_SYNTAX: Record<GestureSyntaxKey, PublicGestureSyntax> = {
  swipe: {
    max: 4,
    usage: 'swipe accepts 4 arguments: x1 y1 x2 y2',
    retired: { positional: 'durationMs', migrate: migrateRetiredSwipeDuration },
  },
  'gesture pan': {
    max: 5,
    usage: 'gesture pan accepts at most 5 arguments: x y dx dy [durationMs]',
  },
  'gesture fling': {
    max: 4,
    usage: 'gesture fling accepts at most 4 arguments: direction x y [distance]',
    retired: {
      positional: 'durationMs',
      migrate: (_args, canonical) => `use "${canonical}", or gesture pan for timed movement.`,
    },
  },
  'gesture swipe': {
    max: 1,
    usage: 'gesture swipe accepts 1 argument: preset',
    retired: {
      positional: 'durationMs',
      migrate: (_args, canonical) => `use "${canonical}", or gesture pan for timed movement.`,
    },
  },
  'gesture pinch': {
    max: 3,
    usage: 'gesture pinch accepts at most 3 arguments: scale [x] [y]',
  },
  'gesture rotate': {
    max: 3,
    usage: 'gesture rotate accepts at most 3 arguments: degrees [x] [y]',
    retired: {
      positional: 'velocity',
      migrate: (_args, canonical) => `use "${canonical}"; rotation pacing derives from degrees.`,
    },
  },
  'gesture transform': {
    max: 7,
    usage: 'gesture transform accepts at most 7 arguments: x y dx dy scale degrees [durationMs]',
  },
  'gesture tap': {
    min: 4,
    max: 10,
    pairs: true,
    usage: 'gesture tap accepts 4 to 10 arguments: x1 y1 x2 y2 [x3 y3 [x4 y4 [x5 y5]]]',
  },
  'gesture drag': {
    max: 5,
    usage:
      'gesture drag accepts at most 5 arguments: source destination [sourceHoldMs] [moveMs] [destinationHoldMs]',
  },
};

/** `swipe x1 y1 x2 y2 durationMs` translates to the equivalent timed pan. */
function migrateRetiredSwipeDuration(args: readonly string[], canonical: string): string {
  const [x1, y1, x2, y2, durationMs] = args;
  const dx = coordinateDelta(x1, x2);
  const dy = coordinateDelta(y1, y2);
  if (dx === undefined || dy === undefined) {
    return `use "gesture pan x1 y1 dx dy durationMs" for the same timed drag, or "${canonical}" for a default-duration swipe.`;
  }
  return `use "gesture pan ${x1} ${y1} ${dx} ${dy} ${durationMs}" for the same timed drag, or "${canonical}" for a default-duration swipe.`;
}

function coordinateDelta(from: string | undefined, to: string | undefined): number | undefined {
  const delta = Number(to) - Number(from);
  return Number.isFinite(delta) ? delta : undefined;
}

/** A rejected argument count, split so a caller can name where the line came from. */
type GestureArityError = { usage: string; migration?: string };

/**
 * The arity error for one public gesture syntax, or `undefined` when the
 * argument count is accepted. Only the count is inspected: a `.ad` line can
 * still hold unresolved `${VAR}` tokens, and interpolation never splits a token.
 */
function describeGestureArityError(
  key: GestureSyntaxKey,
  args: readonly string[],
): GestureArityError | undefined {
  const syntax = PUBLIC_GESTURE_SYNTAX[key];
  if (
    (syntax.min !== undefined && args.length < syntax.min) ||
    (syntax.pairs && args.length % 2 !== 0)
  ) {
    return { usage: syntax.usage };
  }
  if (args.length <= syntax.max) return undefined;
  const retired = syntax.retired;
  if (!retired || args.length !== syntax.max + 1 || !isRetiredSlotArgument(args[syntax.max])) {
    return { usage: syntax.usage };
  }
  const canonical = `${key} ${args.slice(0, syntax.max).join(' ')}`;
  return {
    usage: syntax.usage,
    migration: `The trailing ${retired.positional} positional was removed: ${retired.migrate(args, canonical)}`,
  };
}

/**
 * Whether one extra argument occupies the retired slot. A retired positional was
 * always a number, and a `.ad` script may hold it as an unresolved `${VAR}`, so
 * both report the migration while a stray flag or word stays a usage error.
 */
function isRetiredSlotArgument(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false;
  return value.startsWith('${') || Number.isFinite(Number(value));
}

/**
 * `swipe` is the one public gesture surface whose structured input has no reader
 * of its own — the daemon writer projects known fields — so a removed key would
 * be dropped before the daemon could reject it and a default-duration fling
 * would run instead. Rejecting here covers the Node and MCP boundaries at the
 * same point `readGesturePayload` rejects the gesture kinds' removed keys.
 */
export function assertNoRemovedSwipeInput(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  if ((input as Record<string, unknown>).durationMs === undefined) return;
  throw new AppError(
    'INVALID_ARGS',
    'swipe does not accept durationMs; use gesture pan for timed movement',
  );
}

function formatGestureArityError(error: GestureArityError, source?: string): string {
  const usage = source ? `${error.usage} (${source})` : error.usage;
  return error.migration ? `${usage}. ${error.migration}` : `${usage}.`;
}

function assertGestureArity(key: GestureSyntaxKey, args: readonly string[]): void {
  const error = describeGestureArityError(key, args);
  if (error) throw new AppError('INVALID_ARGS', formatGestureArityError(error));
}

/**
 * The `.ad` preflight for one authored or recorded gesture line, so a script
 * written before the timed-gesture removal reports its migration before the
 * replay executes any device action. `source` names the offending line.
 */
export function describeReplayGestureArityError(
  command: string,
  positionals: readonly string[],
  source: string,
): string | undefined {
  const error = readReplayGestureArityError(command, positionals);
  return error ? formatGestureArityError(error, source) : undefined;
}

function readReplayGestureArityError(
  command: string,
  positionals: readonly string[],
): GestureArityError | undefined {
  if (command === 'swipe') return describeGestureArityError('swipe', positionals);
  if (command !== 'gesture') return undefined;
  const key = `gesture ${positionals[0]}`;
  if (!Object.hasOwn(PUBLIC_GESTURE_SYNTAX, key)) return undefined;
  return describeGestureArityError(key as GestureSyntaxKey, positionals.slice(1));
}

function readOriginDelta(args: readonly string[]): { origin: Point; delta: Point } {
  return {
    origin: { x: Number(args[0]), y: Number(args[1]) },
    delta: { x: Number(args[2]), y: Number(args[3]) },
  };
}

/** The flag-carried gesture inputs, which the CLI and `.ad` replay read alongside positionals. */
export type GesturePositionalFlags = {
  pointerCount?: number;
  holdMs?: number;
  count?: number;
  pauseMs?: number;
};

/** The explicit parser for the public CLI and `.ad` gesture syntax. */
// fallow-ignore-next-line complexity
export function gesturePayloadFromPositionals(
  positionals: readonly string[],
  flags: GesturePositionalFlags = {},
): GesturePayload {
  const { pointerCount } = flags;
  const kind = positionals[0];
  const args = positionals.slice(1);
  switch (kind) {
    case 'pan': {
      assertGestureArity('gesture pan', args);
      const { origin, delta } = readOriginDelta(args);
      return readGesturePayload({
        kind,
        origin,
        delta,
        pointerCount,
        durationMs: optionalPositionNumber(args[4]),
      });
    }
    case 'fling': {
      assertGestureArity('gesture fling', args);
      return readGesturePayload({
        kind,
        direction: args[0],
        origin: { x: Number(args[1]), y: Number(args[2]) },
        distance: optionalPositionNumber(args[3]),
      });
    }
    case 'swipe': {
      assertGestureArity('gesture swipe', args);
      return readGesturePayload({
        kind,
        preset: args[0],
      });
    }
    case 'pinch': {
      assertGestureArity('gesture pinch', args);
      return readGesturePayload({
        kind,
        scale: Number(args[0]),
        origin: optionalOrigin(args[1], args[2]),
      });
    }
    case 'rotate': {
      assertGestureArity('gesture rotate', args);
      return readGesturePayload({
        kind,
        degrees: Number(args[0]),
        origin: optionalOrigin(args[1], args[2]),
      });
    }
    case 'transform': {
      assertGestureArity('gesture transform', args);
      const { origin, delta } = readOriginDelta(args);
      return readGesturePayload({
        kind,
        origin,
        delta,
        scale: Number(args[4]),
        degrees: Number(args[5]),
        durationMs: optionalPositionNumber(args[6]),
      });
    }
    case 'tap': {
      assertGestureArity('gesture tap', args);
      return readGesturePayload({
        kind,
        points: readPositionalPoints(args),
        holdMs: flags.holdMs,
        count: flags.count,
        pauseMs: flags.pauseMs,
      });
    }
    case 'drag': {
      assertGestureArity('gesture drag', args);
      return readGesturePayload({
        kind,
        source: args[0],
        destination: args[1],
        sourceHoldMs: optionalPositionNumber(args[2]),
        moveMs: optionalPositionNumber(args[3]),
        destinationHoldMs: optionalPositionNumber(args[4]),
      });
    }
    default:
      return readGesturePayload({ kind });
  }
}

/** Reads the selector-authored drag grammar without exposing its positional layout. */
export function dragGesturePayloadFromPositionals(
  positionals: readonly string[],
): Extract<GesturePayload, { kind: 'drag' }> | undefined {
  if (positionals[0] !== 'drag') return undefined;
  const payload = gesturePayloadFromPositionals(positionals);
  return payload.kind === 'drag' ? payload : undefined;
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
    case 'tap':
      // Hold, count and pause travel as recorded flags, so the line keeps only the contacts.
      return [input.kind, ...input.points.flatMap((point) => [String(point.x), String(point.y)])];
    case 'drag':
      // Materialize the independent timing slots. Omitting an interior value
      // would shift every following positional and silently change replay.
      return [
        input.kind,
        input.source,
        input.destination,
        String(input.sourceHoldMs ?? DEFAULT_DRAG_SOURCE_HOLD_MS),
        String(input.moveMs ?? DEFAULT_DRAG_MOVE_MS),
        String(input.destinationHoldMs ?? DEFAULT_DRAG_DESTINATION_HOLD_MS),
      ];
  }
}

/** Parses the public CLI and `.ad` coordinate-swipe syntax. */
export function swipePayloadFromPositionals(
  positionals: string[],
  options: Omit<SwipePayload, 'from' | 'to'> = {},
): SwipePayload {
  assertGestureArity('swipe', positionals);
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
    case 'tap':
      return {
        gesture: {
          intent: 'tap',
          points: input.points,
          holdMs: input.holdMs,
        },
      };
    case 'drag':
      throw new AppError(
        'INVALID_ARGS',
        'gesture drag targets must be resolved before coordinate normalization',
      );
  }
}

/** Converts every public gesture payload into the runtime's semantic command shape. */
export function normalizeGestureCommandInput(input: GesturePayload): GestureCommandInput {
  if (input.kind !== 'drag') return normalizePublicGesture(input).gesture;
  return {
    intent: 'drag',
    source: input.source,
    destination: input.destination,
    sourceHoldMs: input.sourceHoldMs,
    moveMs: input.moveMs,
    destinationHoldMs: input.destinationHoldMs,
  };
}

export function normalizePublicSwipeMotion(input: {
  from: Point;
  to: Point;
}): NormalizedPublicGesture {
  return {
    gesture: { intent: 'fling', from: input.from, to: input.to },
  };
}

function readPositionalPoints(args: readonly string[]): Point[] {
  const points: Point[] = [];
  for (let index = 0; index + 1 < args.length; index += 2) {
    points.push({ x: Number(args[index]), y: Number(args[index + 1]) });
  }
  return points;
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
