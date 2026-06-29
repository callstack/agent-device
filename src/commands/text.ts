import { AppError } from '../kernel/errors.ts';

export function normalizeOptionalText(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requireText(value, field);
}

export function requireText(value: string | undefined, field: string): string {
  const text = value?.trim();
  if (!text) {
    throw new AppError('INVALID_ARGS', `${field} must be a non-empty string`);
  }
  return text;
}
