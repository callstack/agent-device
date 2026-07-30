import { AppError } from '@agent-device/kernel/errors';

export function requireIntInRange(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new AppError('INVALID_ARGS', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
