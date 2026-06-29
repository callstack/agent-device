import { AppError } from '../kernel/errors.ts';

export const CLICK_BUTTONS = ['primary', 'secondary', 'middle'] as const;
export type ClickButton = (typeof CLICK_BUTTONS)[number];

type ClickButtonFlags = {
  clickButton?: ClickButton;
};

export function resolveClickButton(flags: ClickButtonFlags | undefined): ClickButton {
  return flags?.clickButton ?? 'primary';
}

export function getClickButtonValidationError(options: {
  commandLabel: string;
  platform: string;
  button: ClickButton;
  count?: number;
  intervalMs?: number;
  holdMs?: number;
  jitterPx?: number;
  doubleTap?: boolean;
}): AppError | null {
  if (options.button === 'primary') {
    return null;
  }
  if (options.commandLabel !== 'click') {
    return new AppError('INVALID_ARGS', '--button is supported only for click');
  }
  if (options.platform !== 'macos' && options.platform !== 'linux') {
    return new AppError(
      'UNSUPPORTED_OPERATION',
      `click --button ${options.button} is supported only on macOS and Linux`,
    );
  }
  if (options.platform === 'macos' && options.button === 'middle') {
    return new AppError(
      'UNSUPPORTED_OPERATION',
      'click --button middle is not supported by the macOS runner yet',
    );
  }
  if (
    typeof options.count === 'number' ||
    typeof options.intervalMs === 'number' ||
    typeof options.holdMs === 'number' ||
    typeof options.jitterPx === 'number' ||
    options.doubleTap === true
  ) {
    return new AppError(
      'INVALID_ARGS',
      `click --button ${options.button} does not support repeat or gesture modifier flags`,
    );
  }
  return null;
}

export function buttonTag(button: ClickButton): {} | { button: ClickButton } {
  return button === 'primary' ? {} : { button };
}
