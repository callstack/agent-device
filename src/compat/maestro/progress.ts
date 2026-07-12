import type { MaestroCommand, MaestroGestureTarget, MaestroSelector } from './program-ir.ts';

export type MaestroCommandProgress = {
  command: string;
  value?: string;
};

export function formatMaestroCommandProgress(command: MaestroCommand): MaestroCommandProgress {
  return {
    command: command.kind,
    ...progressValue(command),
  };
}

function progressValue(command: MaestroCommand): Pick<MaestroCommandProgress, 'value'> {
  switch (command.kind) {
    case 'tapOn':
    case 'doubleTapOn':
    case 'longPressOn':
      return valueOf(formatGestureTarget(command.target));
    case 'assertVisible':
    case 'assertNotVisible':
      return valueOf(formatSelector(command.target));
    case 'extendedWaitUntil':
      return valueOf(formatSelector(command.visible ?? command.notVisible));
    case 'scrollUntilVisible':
      return valueOf(formatSelector(command.element));
    case 'inputText':
    case 'pasteText':
      return valueOf(command.text);
    case 'openLink':
      return valueOf(command.link);
    case 'takeScreenshot':
      return valueOf(command.path);
    case 'runScript':
      return valueOf(command.file);
    case 'swipe':
      return valueOf(
        command.gesture.kind === 'coordinates'
          ? `${formatCoordinate(command.gesture.start)} to ${formatCoordinate(command.gesture.end)}`
          : command.gesture.direction,
      );
    case 'pressKey':
      return valueOf(command.key);
    case 'runFlow':
      return valueOf(
        command.label ?? (command.include.kind === 'file' ? command.include.path : ''),
      );
    default:
      return {};
  }
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
