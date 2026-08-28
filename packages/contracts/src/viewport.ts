import { AppError } from '@agent-device/kernel/errors';

function readViewportDimension(value: string | undefined, label: 'width' | 'height'): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('INVALID_ARGS', `viewport ${label} must be a positive integer`);
  }
  return parsed;
}

export function readViewportDimensions(positionals: readonly string[]) {
  if (positionals.length !== 2) {
    throw new AppError('INVALID_ARGS', 'viewport requires exactly two arguments: <width> <height>');
  }
  return {
    width: readViewportDimension(positionals[0], 'width'),
    height: readViewportDimension(positionals[1], 'height'),
  };
}

export type ViewportCommandResult = {
  width: number;
  height: number;
  message: string;
};
