import { AppError } from '@agent-device/kernel/errors';

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

export function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be a finite number.`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be at least ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be at most ${options.max}.`);
  }
  return value;
}
