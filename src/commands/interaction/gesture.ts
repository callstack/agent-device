import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
import { AppError } from '../../kernel/errors.ts';
import { commonInputFromFlags, optionalCliNumber, request } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { readGestureInput, type GestureInput } from './metadata.ts';
import { compactRecord } from '../command-input.ts';

export const gestureCliReaders = {
  gesture: gestureInputFromCli,
} satisfies Record<string, CliReader>;

export const gestureDaemonWriters = {
  gesture: (input) => {
    const gesture = readGestureInput(input);
    return request(PUBLIC_COMMANDS.gesture, [], input, gestureDaemonInput(gesture));
  },
} satisfies Record<string, DaemonWriter>;

function gestureDaemonInput(input: GestureInput): Record<string, unknown> {
  switch (input.kind) {
    case 'pan':
      return compactRecord({
        kind: input.kind,
        origin: input.origin,
        delta: input.delta,
        pointerCount: input.pointerCount,
        durationMs: input.durationMs,
      });
    case 'fling':
      return compactRecord({
        kind: input.kind,
        direction: input.direction,
        origin: input.origin,
        distance: input.distance,
        durationMs: input.durationMs,
      });
    case 'swipe':
      return compactRecord({
        kind: input.kind,
        preset: input.preset,
        durationMs: input.durationMs,
      });
    case 'pinch':
      return compactRecord({ kind: input.kind, scale: input.scale, origin: input.origin });
    case 'rotate':
      return compactRecord({
        kind: input.kind,
        degrees: input.degrees,
        origin: input.origin,
        velocity: input.velocity,
      });
    case 'transform':
      return compactRecord({
        kind: input.kind,
        origin: input.origin,
        delta: input.delta,
        scale: input.scale,
        degrees: input.degrees,
        durationMs: input.durationMs,
      });
  }
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
        pointerCount: flags.pointerCount,
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
