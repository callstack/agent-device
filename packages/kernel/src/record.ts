import { AppError } from '@agent-device/kernel/errors';
import type { DeviceKind, DeviceTarget, PublicPlatform } from '@agent-device/kernel/device';
import type {
  Point,
  PresentedSurface,
  Rect,
  SnapshotKeyboardBandFact,
} from '@agent-device/kernel/snapshot';

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
 * and never trusted: silence would tell the tap guard the producer never looked. Validation reasons
 * identify the rejected shape: `malformed-fact`, `unrecognized-kind`, `unreported-reason`,
 * `invalid-visibility-probe`, `unrecognized-derivation`, `invalid-visible-frame`, or
 * `invalid-derived-frame`. They describe validation failures rather than levels of trust.
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
  if (value.kind === 'tree-rejected') return readKeyboardTreeRejection(value);
  if (value.kind === 'visibility-only') {
    return typeof value.visible === 'boolean'
      ? { kind: 'visibility-only', visible: value.visible }
      : { kind: 'unmeasurable', reason: 'invalid-visibility-probe' };
  }
  if (value.kind === 'derived' && value.derivation !== 'docked-tree') {
    return { kind: 'unmeasurable', reason: 'unrecognized-derivation' };
  }
  if (value.kind === 'visible' || value.kind === 'derived') {
    return readKeyboardFrameFact(value.frame, value.kind);
  }
  return { kind: 'unmeasurable', reason: 'unrecognized-kind' };
}

function readKeyboardTreeRejection(value: Record<string, unknown>): SnapshotKeyboardBandFact {
  if (value.derivation !== 'docked-tree') {
    return { kind: 'unmeasurable', reason: 'unrecognized-derivation' };
  }
  if (value.visible !== undefined && typeof value.visible !== 'boolean') {
    return { kind: 'unmeasurable', reason: 'invalid-visibility-probe' };
  }
  return {
    kind: 'tree-rejected',
    derivation: 'docked-tree',
    ...(typeof value.visible === 'boolean' ? { visible: value.visible } : {}),
  };
}

function readKeyboardFrameFact(
  value: unknown,
  kind: 'visible' | 'derived',
): SnapshotKeyboardBandFact {
  const frame = parseRect(value);
  // Same rule as `isPositiveFiniteRect` in kernel/rect, inlined: this module is a leaf that
  // many facades evaluate, and a rect import here would land in every one of their closures.
  // The viewport re-read (#3182) is the other side of that seam and lives in kernel/rect as
  // `readSnapshotViewportSize`, because a viewport IS a rect; readers take the rect module there.
  const plottable =
    frame !== undefined &&
    [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) &&
    frame.width > 0 &&
    frame.height > 0;
  if (!plottable) return { kind: 'unmeasurable', reason: `invalid-${kind}-frame` };
  return kind === 'derived'
    ? { kind: 'derived', derivation: 'docked-tree', frame }
    : { kind: 'visible', frame };
}

/**
 * The declared states, each keyed by its own name so a payload string is a state only when this table
 * has that exact key. Keyed by `PresentedSurface`, so a state added to the vocabulary without a row
 * here fails to compile instead of silently reading as `unknown`.
 */
const PRESENTED_SURFACE_BY_NAME: Readonly<Record<PresentedSurface, PresentedSurface>> = {
  presented: 'presented',
  absent: 'absent',
  unknown: 'unknown',
};

/** The key a producer publishes its presented-surface fact under (#3565). */
const PRESENTED_SURFACE_WIRE_KEY = 'presentedSurface';

/**
 * Reads a producer's presented-surface fact (#3565) out of a response or runner payload, shared by the
 * Apple runner's wire reader and the Node client's. Taking the payload rather than the value is the
 * point: reading a wire fact is a property lookup on data the producer controls, so it has to be
 * own-property both ways. A missing key is the producer stating nothing and stays silence — and an
 * inherited one is not silence's substitute, since a plain lookup walks to `Object.prototype`, where
 * anything sharing the process could park `'absent'`, the one state that disarms the confirmation
 * #1831 arms. A value under the fact's own key which is not one of the three states is restated as
 * `'unknown'` rather than dropped: the reader cannot tell a malformed `'absent'` from a genuine one,
 * and silence would leave a consumer arming a dismissal confirmation on nothing — the guessing this
 * fact retires. Only a name in this table is trusted, so a payload naming `constructor` is not.
 */
export function readPresentedSurfaceFact(
  payload: Record<string, unknown>,
): PresentedSurface | undefined {
  if (!Object.hasOwn(payload, PRESENTED_SURFACE_WIRE_KEY)) return undefined;
  const value = payload[PRESENTED_SURFACE_WIRE_KEY];
  return typeof value === 'string' && Object.hasOwn(PRESENTED_SURFACE_BY_NAME, value)
    ? PRESENTED_SURFACE_BY_NAME[value as PresentedSurface]
    : 'unknown';
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
