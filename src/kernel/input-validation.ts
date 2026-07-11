import { AppError } from './errors.ts';

export function readOptionalInteger(
  record: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be an integer.`);
  }
  const numberValue = value as number;
  if (options.min !== undefined && numberValue < options.min) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be at least ${options.min}.`);
  }
  if (options.max !== undefined && numberValue > options.max) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be at most ${options.max}.`);
  }
  return numberValue;
}
