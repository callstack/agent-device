import { AppError } from '../kernel/errors.ts';

export function readViewportDimension(
  value: string | undefined,
  label: 'width' | 'height',
): number {
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('INVALID_ARGS', `viewport ${label} must be a positive integer`);
  }
  return parsed;
}
