import { AppError } from '@agent-device/kernel/errors';

/** Primitive readers shared by the common-field table and the per-command field constructors. */

export function readInputRecord(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_ARGS', 'Expected object arguments.');
  }
  return input as Record<string, unknown>;
}

export function readRecordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be a non-empty string.`);
  }
  return value;
}

/**
 * Opt-in reader for the one field where the empty string is a VALUE, not a missing input:
 * `fill <target> ""` is the clear-field primitive (#2063). `requiredField` still refuses a
 * missing key, so "" and absent stay distinguishable; every other string field keeps
 * {@link optionalString}'s non-empty rule.
 */
export function optionalAnyString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be a string.`);
  }
  return value;
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be a non-empty string.`);
  }
  return value;
}

export function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be a finite number.`);
  }
  return value;
}

export function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be a boolean.`);
  }
  return value;
}

export function requiredEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
): T[number] {
  const value = record[key];
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be one of: ${values.join(', ')}.`);
  }
  return value;
}

export function optionalEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
): T[number] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be one of: ${values.join(', ')}.`);
  }
  return value;
}

export function optionalRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be an object.`);
  }
  return value as Record<string, unknown>;
}

export function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be an array of strings.`);
  }
  return value as string[];
}

export function assertAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
  hint?: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new AppError(
      'INVALID_ARGS',
      `${label} has unknown field(s): ${unknownKeys.join(', ')}.`,
      hint === undefined ? undefined : { hint },
    );
  }
}

export function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
