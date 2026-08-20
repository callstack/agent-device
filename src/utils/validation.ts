import { AppError } from '@agent-device/kernel/errors';
import type { Point } from '@agent-device/kernel/snapshot';

export function requireIntInRange(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new AppError('INVALID_ARGS', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * The `x y` positional pair every point-addressed command takes. `Number`, not an integer parse:
 * a fractional coordinate has always been legal, and only a non-numeric one is rejected.
 *
 * Shared rather than restated so a migrated command and its still-legacy siblings cannot drift
 * apart on what "requires x y" means.
 */
export function readPointPositionals(
  positionals: readonly string[],
  errorMessage: string,
  details?: Record<string, unknown>,
): Point {
  const x = Number(positionals[0]);
  const y = Number(positionals[1]);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    throw new AppError('INVALID_ARGS', errorMessage, details);
  }
  return { x, y };
}
