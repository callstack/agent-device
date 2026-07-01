import { AppError } from '../kernel/errors.ts';
import type { DeviceKind, DeviceTarget, PublicPlatform } from '../kernel/device.ts';
import type { Point, Rect } from '../kernel/snapshot.ts';

function readRequired<T>(
  record: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => T | undefined,
  message: string,
): T {
  const value = parse(record[key]);
  if (value === undefined) {
    throw new AppError('COMMAND_FAILED', message, { response: record });
  }
  return value;
}

function readOptional<T>(
  record: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => T | undefined,
): T | undefined {
  return parse(record[key]);
}

function readNullable<T>(
  record: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => T | undefined,
): T | null | undefined {
  const value = record[key];
  return value === null ? null : parse(value);
}

export function readRequiredString(record: Record<string, unknown>, key: string): string {
  return readRequired(record, key, parseNonEmptyString, `Daemon response is missing "${key}".`);
}

export function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return readOptional(record, key, parseNonEmptyString);
}

export function readNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  return readNullable(record, key, parseNonEmptyString);
}

export function readRequiredNumber(record: Record<string, unknown>, key: string): number {
  return readRequired(
    record,
    key,
    parseFiniteNumber,
    `Daemon response is missing numeric "${key}".`,
  );
}

export function readRequiredPlatform(record: Record<string, unknown>, key: string): PublicPlatform {
  return readRequired(record, key, parsePlatform, `Daemon response has invalid "${key}".`);
}

export function readRequiredDeviceKind(record: Record<string, unknown>, key: string): DeviceKind {
  return readRequired(record, key, parseDeviceKind, `Daemon response has invalid "${key}".`);
}

export function readDeviceTarget(record: Record<string, unknown>, key: string): DeviceTarget {
  return readOptional(record, key, parseDeviceTarget) ?? 'mobile';
}

export function parseRect(value: unknown): Rect | undefined {
  if (!isRecord(value)) return undefined;
  const x = readNumberField(value, 'x');
  const y = readNumberField(value, 'y');
  const width = readNumberField(value, 'width');
  const height = readNumberField(value, 'height');
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

export function parsePoint(value: unknown): Point | undefined {
  if (!isRecord(value)) return undefined;
  const x = readNumberField(value, 'x');
  const y = readNumberField(value, 'y');
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return { x, y };
}

function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function parseNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// Client-side parser for the PUBLIC leaf platform a daemon response carries. Under
// approach (b) the daemon always emits leaf strings (`ios`/`macos`), never the
// internal `apple`; the extra `apple` acceptance is forward-compat only, and — being
// unable to disambiguate the Apple OS from the bare token — maps to the dominant
// `ios` leaf (unreachable today, since output is never `apple`).
function parsePlatform(value: unknown): PublicPlatform | undefined {
  if (value === 'apple') return 'ios';
  return value === 'ios' ||
    value === 'macos' ||
    value === 'android' ||
    value === 'linux' ||
    value === 'web'
    ? value
    : undefined;
}

function parseDeviceKind(value: unknown): DeviceKind | undefined {
  return value === 'simulator' || value === 'emulator' || value === 'device' ? value : undefined;
}

function parseDeviceTarget(value: unknown): DeviceTarget | undefined {
  return value === 'tv' || value === 'mobile' || value === 'desktop' ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AppError('COMMAND_FAILED', 'Daemon returned an unexpected response shape.', {
      value,
    });
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const output = {} as T;
  for (const [key, current] of Object.entries(value)) {
    if (current !== undefined) {
      (output as Record<string, unknown>)[key] = current;
    }
  }
  return output;
}

export function splitNonEmptyTrimmedLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
