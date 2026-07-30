import type { MaestroCommand, MaestroGestureTarget, MaestroSelector } from './program-ir.ts';
import { isMaestroControlCommandDescriptor, type MaestroEngineEvent } from './engine-types.ts';

export type MaestroCommandProgress = {
  command: string;
  value?: string;
};

export function formatMaestroCommandProgress(
  command: MaestroEngineEvent['command'],
): MaestroCommandProgress {
  if (isMaestroControlCommandDescriptor(command)) {
    return {
      command: command.kind,
      ...(command.kind === 'runFlow' ? valueOf(command.label ?? command.includePath) : {}),
    };
  }
  return {
    command: command.kind,
    ...progressValue(command),
  };
}

function progressValue(command: MaestroCommand): Pick<MaestroCommandProgress, 'value'> {
  if (isGestureTargetCommand(command)) return valueOf(formatGestureTarget(command.target));
  if (isSelectorProgressCommand(command)) return selectorProgressValue(command);
  if (command.kind === 'inputText') return valueOf('<text>');
  return commandDetailProgressValue(command);
}

type GestureTargetCommand = Extract<
  MaestroCommand,
  { kind: 'tapOn' | 'doubleTapOn' | 'longPressOn' }
>;

function isGestureTargetCommand(command: MaestroCommand): command is GestureTargetCommand {
  return (
    command.kind === 'tapOn' || command.kind === 'doubleTapOn' || command.kind === 'longPressOn'
  );
}

type SelectorProgressCommand = Extract<
  MaestroCommand,
  { kind: 'assertVisible' | 'assertNotVisible' | 'extendedWaitUntil' | 'scrollUntilVisible' }
>;

function isSelectorProgressCommand(command: MaestroCommand): command is SelectorProgressCommand {
  return (
    command.kind === 'assertVisible' ||
    command.kind === 'assertNotVisible' ||
    command.kind === 'extendedWaitUntil' ||
    command.kind === 'scrollUntilVisible'
  );
}

function selectorProgressValue(
  command: SelectorProgressCommand,
): Pick<MaestroCommandProgress, 'value'> {
  switch (command.kind) {
    case 'assertVisible':
    case 'assertNotVisible':
      return valueOf(formatSelector(command.target));
    case 'extendedWaitUntil':
      return valueOf(formatSelector(command.visible ?? command.notVisible));
    case 'scrollUntilVisible':
      return valueOf(formatSelector(command.element));
  }
}

function commandDetailProgressValue(
  command: Exclude<MaestroCommand, GestureTargetCommand | SelectorProgressCommand>,
): Pick<MaestroCommandProgress, 'value'> {
  if (isSimpleDetailCommand(command)) return simpleDetailProgressValue(command);
  if (command.kind === 'swipe') return swipeProgressValue(command);
  if (command.kind === 'runFlow') {
    return valueOf(command.label ?? (command.include.kind === 'file' ? command.include.path : ''));
  }
  return {};
}

type SimpleDetailCommand = Extract<
  MaestroCommand,
  { kind: 'openLink' | 'takeScreenshot' | 'runScript' | 'pressKey' }
>;

function isSimpleDetailCommand(command: MaestroCommand): command is SimpleDetailCommand {
  return (
    command.kind === 'openLink' ||
    command.kind === 'takeScreenshot' ||
    command.kind === 'runScript' ||
    command.kind === 'pressKey'
  );
}

function simpleDetailProgressValue(
  command: SimpleDetailCommand,
): Pick<MaestroCommandProgress, 'value'> {
  switch (command.kind) {
    case 'openLink':
      return valueOf(command.link);
    case 'takeScreenshot':
      return valueOf(command.path);
    case 'runScript':
      return valueOf(command.file);
    case 'pressKey':
      return valueOf(command.key);
  }
}

function swipeProgressValue(
  command: Extract<MaestroCommand, { kind: 'swipe' }>,
): Pick<MaestroCommandProgress, 'value'> {
  return valueOf(
    command.gesture.kind === 'coordinates'
      ? `${formatCoordinate(command.gesture.start)} to ${formatCoordinate(command.gesture.end)}`
      : command.gesture.direction,
  );
}

function formatGestureTarget(target: MaestroGestureTarget): string | undefined {
  return target.space === 'target'
    ? formatSelector(target.selector)
    : `${target.x},${target.y}${target.space === 'percent' ? '%' : ''}`;
}

function formatSelector(selector: MaestroSelector | undefined): string | undefined {
  return selector?.id ?? selector?.text ?? selector?.label;
}

function formatCoordinate(coordinate: { space: 'absolute' | 'percent'; x: number; y: number }) {
  return `${coordinate.x},${coordinate.y}${coordinate.space === 'percent' ? '%' : ''}`;
}

function valueOf(value: string | undefined): Pick<MaestroCommandProgress, 'value'> {
  return value ? { value } : {};
}
