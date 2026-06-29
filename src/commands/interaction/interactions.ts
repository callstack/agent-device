import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type {
  ElementTarget,
  FillOptions,
  InteractionTarget,
  LongPressOptions,
  TypeTextOptions,
} from '../../client-types.ts';
import {
  readFillTargetFromPositionals,
  readInteractionTargetFromPositionals,
} from '../../core/interaction-positionals.ts';
import { AppError } from '../../kernel/errors.ts';
import type { ScrollInputDirection } from './runtime/gestures.ts';
import {
  commonInputFromFlags,
  direct,
  elementTargetPositionals,
  interactionTargetPositionals,
  isFiniteNumberString,
  optionalCliNumber,
  optionalNumber,
  readElementTargetFromPositionals,
  readGetFormat,
  request,
  requiredDaemonString,
  repeatedInputFromFlags,
  selectorSnapshotInputFromFlags,
  targetInputFromClientTarget,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter, CommandInput } from '../cli-grammar/types.ts';

export const interactionCliReaders = {
  click: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    ...selectorSnapshotInputFromFlags(flags),
    ...repeatedInputFromFlags(flags),
    target: targetInputFromClientTarget(readInteractionTargetFromPositionals(positionals)),
    button: flags.clickButton,
  }),
  press: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    ...selectorSnapshotInputFromFlags(flags),
    ...repeatedInputFromFlags(flags),
    target: targetInputFromClientTarget(readInteractionTargetFromPositionals(positionals)),
  }),
  longpress: (positionals, flags) => {
    const decoded = readLongPressTargetFromPositionals(positionals);
    return {
      ...commonInputFromFlags(flags),
      ...selectorSnapshotInputFromFlags(flags),
      target: targetInputFromClientTarget(decoded),
      durationMs: decoded.durationMs,
    };
  },
  swipe: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    from: { x: Number(positionals[0]), y: Number(positionals[1]) },
    to: { x: Number(positionals[2]), y: Number(positionals[3]) },
    durationMs: optionalCliNumber(positionals[4]),
    count: flags.count,
    pauseMs: flags.pauseMs,
    pattern: flags.pattern,
  }),
  focus: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    x: Number(positionals[0]),
    y: Number(positionals[1]),
  }),
  type: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    text: positionals.join(' '),
    delayMs: flags.delayMs,
  }),
  fill: (positionals, flags) => {
    const decoded = readFillTargetFromPositionals(positionals);
    return {
      ...commonInputFromFlags(flags),
      ...selectorSnapshotInputFromFlags(flags),
      target: targetInputFromClientTarget(decoded.target),
      text: decoded.text,
      delayMs: flags.delayMs,
    };
  },
  scroll: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    direction: readScrollDirection(positionals[0]),
    amount: optionalCliNumber(positionals[1]),
    pixels: flags.pixels,
    durationMs: flags.durationMs,
  }),
  get: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    ...selectorSnapshotInputFromFlags(flags),
    format: readGetFormat(positionals[0]),
    target: targetInputFromClientTarget(readElementTargetFromPositionals(positionals.slice(1))),
  }),
} satisfies Record<string, CliReader>;

export const interactionDaemonWriters = {
  click: (input) =>
    request(PUBLIC_COMMANDS.click, interactionTargetPositionals(input as InteractionTarget), {
      ...input,
      clickButton: input.button,
    }),
  press: direct(PUBLIC_COMMANDS.press, (input) =>
    interactionTargetPositionals(input as InteractionTarget),
  ),
  longpress: direct(PUBLIC_COMMANDS.longPress, (input) =>
    longPressPositionals(input as LongPressOptions),
  ),
  swipe: direct(PUBLIC_COMMANDS.swipe, swipePositionals),
  focus: direct(PUBLIC_COMMANDS.focus, (input) => [String(input.x), String(input.y)]),
  type: direct(PUBLIC_COMMANDS.type, (input) => typePositionals(input as TypeTextOptions)),
  fill: direct(PUBLIC_COMMANDS.fill, (input) => fillPositionals(input as FillOptions)),
  scroll: direct(PUBLIC_COMMANDS.scroll, (input) => [
    requiredDaemonString(input.direction, 'scroll requires direction'),
    ...optionalNumber(input.amount),
  ]),
  get: direct(PUBLIC_COMMANDS.get, (input) => [
    requiredDaemonString(input.format, 'get requires format'),
    ...elementTargetPositionals(input as ElementTarget),
  ]),
} satisfies Record<string, DaemonWriter>;

function readLongPressTargetFromPositionals(positionals: string[]): LongPressOptions {
  const targetPositionals = readLongPressTargetPositionals(positionals);
  return {
    ...readInteractionTargetFromPositionals(targetPositionals.target),
    ...(targetPositionals.durationMs !== undefined
      ? { durationMs: targetPositionals.durationMs }
      : {}),
  };
}

function longPressPositionals(input: LongPressOptions): string[] {
  return [...interactionTargetPositionals(input), ...optionalNumber(input.durationMs)];
}

function typePositionals(input: TypeTextOptions): string[] {
  return [input.text];
}

function fillPositionals(input: FillOptions): string[] {
  return [...interactionTargetPositionals(input), input.text];
}

function swipePositionals(input: CommandInput): string[] {
  return [
    String(input.from?.x),
    String(input.from?.y),
    String(input.to?.x),
    String(input.to?.y),
    ...optionalNumber(input.durationMs),
  ];
}

function readScrollDirection(value: string | undefined): ScrollInputDirection {
  if (
    value === 'up' ||
    value === 'down' ||
    value === 'left' ||
    value === 'right' ||
    value === 'top' ||
    value === 'bottom'
  ) {
    return value;
  }
  throw new AppError('INVALID_ARGS', `Unknown direction: ${String(value)}`);
}

function readLongPressTargetPositionals(positionals: string[]): {
  target: string[];
  durationMs?: number;
} {
  if (isFiniteNumberString(positionals[0]) && isFiniteNumberString(positionals[1])) {
    return {
      target: positionals.slice(0, 2),
      ...(positionals[2] !== undefined ? { durationMs: Number(positionals[2]) } : {}),
    };
  }
  const last = positionals.at(-1);
  if (positionals.length > 1 && isFiniteNumberString(last)) {
    return { target: positionals.slice(0, -1), durationMs: Number(last) };
  }
  return { target: positionals };
}
