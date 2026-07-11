import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { FlingOptions, RotateGestureOptions } from '../../client/client-types.ts';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
import { AppError } from '../../kernel/errors.ts';
import {
  commonInputFromFlags,
  direct,
  optionalCliNumber,
  optionalNumber,
  requiredDaemonString,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter, CommandInput } from '../cli-grammar/types.ts';

export const gestureCliReaders = {
  gesture: gestureInputFromCli,
} satisfies Record<string, CliReader>;

export const gestureDaemonWriters = {
  gesture: direct(PUBLIC_COMMANDS.gesture, gesturePositionals),
  'gesture-pan': direct(PUBLIC_COMMANDS.gesture, panPositionals),
  'gesture-fling': direct(PUBLIC_COMMANDS.gesture, (input) =>
    flingPositionals(input as FlingOptions),
  ),
  'gesture-swipe': direct(PUBLIC_COMMANDS.gesture, swipePresetPositionals),
  'gesture-pinch': direct(PUBLIC_COMMANDS.gesture, pinchPositionals),
  'gesture-rotate': direct(PUBLIC_COMMANDS.gesture, (input) =>
    rotateGesturePositionals(input as RotateGestureOptions),
  ),
  'gesture-transform': direct(PUBLIC_COMMANDS.gesture, transformPositionals),
} satisfies Record<string, DaemonWriter>;

// fallow-ignore-next-line complexity
function gesturePositionals(input: CommandInput): string[] {
  switch (input.kind) {
    case 'pan':
      return [
        'pan',
        String(input.origin?.x),
        String(input.origin?.y),
        String(input.delta?.x),
        String(input.delta?.y),
        ...optionalNumber(input.durationMs),
      ];
    case 'fling':
      return [
        'fling',
        requiredDaemonString(input.direction, 'gesture fling requires direction'),
        String(input.origin?.x),
        String(input.origin?.y),
        ...optionalNumber(input.distance),
        ...optionalNumber(input.durationMs),
      ];
    case 'swipe':
      return swipePresetPositionals(input);
    case 'pinch':
      return [
        'pinch',
        String(input.scale),
        ...optionalNumber(input.origin?.x),
        ...optionalNumber(input.origin?.y),
      ];
    case 'rotate':
      return [
        'rotate',
        String(input.degrees),
        ...optionalNumber(input.origin?.x),
        ...optionalNumber(input.origin?.y),
        ...optionalNumber(input.velocity),
      ];
    case 'transform':
      return [
        'transform',
        String(input.origin?.x),
        String(input.origin?.y),
        String(input.delta?.x),
        String(input.delta?.y),
        String(input.scale),
        String(input.degrees),
        ...optionalNumber(input.durationMs),
      ];
    default:
      throw new AppError(
        'INVALID_ARGS',
        'gesture requires pan, fling, swipe, pinch, rotate, or transform',
      );
  }
}

function swipePresetPositionals(input: CommandInput): string[] {
  return [
    'swipe',
    requiredDaemonString(input.preset, 'gesture swipe requires preset'),
    ...optionalNumber(input.durationMs),
  ];
}

function panPositionals(input: CommandInput): string[] {
  return [
    'pan',
    String(input.x),
    String(input.y),
    String(input.dx),
    String(input.dy),
    ...optionalNumber(input.durationMs),
  ];
}

function flingPositionals(input: FlingOptions): string[] {
  const distance = input.durationMs !== undefined ? (input.distance ?? 180) : input.distance;
  return [
    'fling',
    input.direction,
    String(input.x),
    String(input.y),
    ...optionalNumber(distance),
    ...optionalNumber(input.durationMs),
  ];
}

function pinchPositionals(input: CommandInput): string[] {
  return ['pinch', String(input.scale), ...optionalNumber(input.x), ...optionalNumber(input.y)];
}

function rotateGesturePositionals(input: RotateGestureOptions): string[] {
  assertCompleteCenter(input);
  const center =
    input.x === undefined || input.y === undefined ? [] : [String(input.x), String(input.y)];
  return ['rotate', String(input.degrees), ...center, ...optionalNumber(input.velocity)];
}

function transformPositionals(input: CommandInput): string[] {
  return [
    'transform',
    String(input.x),
    String(input.y),
    String(input.dx),
    String(input.dy),
    String(input.scale),
    String(input.degrees),
    ...optionalNumber(input.durationMs),
  ];
}

// fallow-ignore-next-line complexity
function gestureInputFromCli(positionals: string[], flags: CliFlags): Record<string, unknown> {
  const subcommand = positionals[0];
  const args = positionals.slice(1);
  const common = commonInputFromFlags(flags);
  switch (subcommand) {
    case 'pan':
      return {
        ...common,
        kind: subcommand,
        origin: { x: Number(args[0]), y: Number(args[1]) },
        delta: { x: Number(args[2]), y: Number(args[3]) },
        durationMs: optionalCliNumber(args[4]),
      };
    case 'fling':
      return {
        ...common,
        kind: subcommand,
        direction: args[0],
        origin: { x: Number(args[1]), y: Number(args[2]) },
        distance: optionalCliNumber(args[3]),
        durationMs: optionalCliNumber(args[4]),
      };
    case 'swipe':
      return {
        ...common,
        kind: subcommand,
        preset: args[0],
        durationMs: optionalCliNumber(args[1]),
      };
    case 'pinch':
      return {
        ...common,
        kind: subcommand,
        scale: Number(args[0]),
        origin:
          args[1] === undefined || args[2] === undefined
            ? undefined
            : { x: Number(args[1]), y: Number(args[2]) },
      };
    case 'rotate':
      return {
        ...common,
        kind: subcommand,
        degrees: Number(args[0]),
        origin:
          args[1] === undefined || args[2] === undefined
            ? undefined
            : { x: Number(args[1]), y: Number(args[2]) },
        velocity: optionalCliNumber(args[3]),
      };
    case 'transform':
      return {
        ...common,
        kind: subcommand,
        origin: { x: Number(args[0]), y: Number(args[1]) },
        delta: { x: Number(args[2]), y: Number(args[3]) },
        scale: Number(args[4]),
        degrees: Number(args[5]),
        durationMs: optionalCliNumber(args[6]),
      };
    default:
      throw new AppError(
        'INVALID_ARGS',
        'gesture requires pan, fling, swipe, pinch, rotate, or transform',
      );
  }
}

function assertCompleteCenter(input: RotateGestureOptions): void {
  if (
    (input.x === undefined && input.y !== undefined) ||
    (input.x !== undefined && input.y === undefined)
  ) {
    throw new AppError('INVALID_ARGS', 'gesture rotate center requires both x and y');
  }
}
