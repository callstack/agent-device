import { AppError } from '../../../kernel/errors.ts';
import { isRecord } from '../../../utils/parsing.ts';

const UUID_RE = /^[0-9a-fA-F-]{32,36}$/;

export function normalizeUuid(value: string | undefined): string | undefined {
  if (!value || !UUID_RE.test(value)) return undefined;
  return value.replaceAll('-', '').toUpperCase();
}

export function addressKey(image: { uuid: string }, address: bigint): string {
  return `${image.uuid}:${hex(address)}`;
}

export function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const stringValue = readString(value);
    if (stringValue) return stringValue;
  }
  return undefined;
}

export function compactJoin(values: (string | undefined)[]): string | undefined {
  const compact = values.filter((value): value is string => Boolean(value));
  return compact.length > 0 ? compact.join(' ') : undefined;
}

export function readJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function readIntegerNumberField(
  record: Record<string, unknown>,
  key: string,
  context: string,
): number | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = readNumber(record[key]);
  if (value !== undefined) return value;
  throwInvalidNumericField(context, key);
}

export function readBigIntField(
  record: Record<string, unknown>,
  key: string,
  context: string,
): bigint | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = readBigInt(record[key]);
  if (value !== undefined) return value;
  throwInvalidNumericField(context, key);
}

function readBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value !== 'string') return undefined;
  if (!/^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) return undefined;
  return BigInt(value);
}

function throwInvalidNumericField(context: string, key: string): never {
  throw new AppError('INVALID_ARGS', `Invalid ${context} numeric field: ${key}`, {
    hint: 'Crash artifact numeric fields must be integer numbers or integer numeric strings.',
  });
}

export function single<T>(values: T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function parseAtosSymbol(value: string): { symbol: string; location?: number } {
  const match = value.match(/^(.*) \+ (\d+)$/);
  if (!match) return { symbol: value };
  return { symbol: match[1]!, location: Number(match[2]) };
}
