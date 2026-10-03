import { AppError } from '@agent-device/kernel/errors';
import type { DeviceKind, DeviceTarget, PublicPlatform } from '@agent-device/kernel/device';
import type { Point, Rect, SnapshotKeyboardBandFact } from '@agent-device/kernel/snapshot';

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

/**
 * Reads a producer-declared keyboard band (#2660) out of an untyped payload, shared by every seam
 * that receives one: the Apple runner's wire reader, the daemon's Node client reader. `undefined`
 * means the producer published no fact at all, which is how a tier that never reads the keyboard is
 * distinguished from one that measured and reported.
 *
 * A payload that cannot be placed is restated as `unmeasurable` naming where it failed, never dropped
 * and never trusted: silence would tell the tap guard the producer never looked. The reasons resolve
 * in a fixed order, least to most trusted: a value that is not an object is `malformed-fact`; an
 * unrecognized `kind` is `unrecognized-kind`; an `unmeasurable` that never named its failure is
 * `unreported-reason`; a `visible` whose frame is not a positive finite rect is
 * `invalid-visible-frame`.
 */
export function readSnapshotKeyboardBandFact(value: unknown): SnapshotKeyboardBandFact | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return { kind: 'unmeasurable', reason: 'malformed-fact' };
  if (value.kind === 'absent') return { kind: 'absent' };
  if (value.kind === 'unmeasurable') {
    return typeof value.reason === 'string' && value.reason.trim().length > 0
      ? { kind: 'unmeasurable', reason: value.reason }
      : { kind: 'unmeasurable', reason: 'unreported-reason' };
  }
  if (value.kind === 'visible') {
    const frame = parseRect(value.frame);
    // Same rule as `isPositiveFiniteRect` in kernel/rect, inlined: this module is a leaf that
    // many facades evaluate, and a rect import here would land in every one of their closures.
    const plottable =
      frame !== undefined &&
      [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) &&
      frame.width > 0 &&
      frame.height > 0;
    return plottable
      ? { kind: 'visible', frame }
      : { kind: 'unmeasurable', reason: 'invalid-visible-frame' };
  }
  return { kind: 'unmeasurable', reason: 'unrecognized-kind' };
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
    value === 'harmonyos' ||
    value === 'vega' ||
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

export function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

type WithoutUndefined<T extends Record<string, unknown>> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function stripUndefined<T extends Record<string, unknown>>(value: T): WithoutUndefined<T> {
  const output = {} as WithoutUndefined<T>;
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
