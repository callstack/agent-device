import { AppError } from '../../kernel/errors.ts';

// Shared primitives for the Android instrumentation helpers (snapshot + multi-touch).
// Both helpers drive `am instrument -w` and parse the resulting
// INSTRUMENTATION_STATUS / INSTRUMENTATION_RESULT key/value records, and both
// validate a bundled JSON manifest with the same integer/literal field rules.

type AndroidInstrumentationRecordState = {
  status: Array<Record<string, string>>;
  results: Array<Record<string, string>>;
  currentStatus: Record<string, string> | null;
  currentResult: Record<string, string> | null;
};

export function parseInstrumentationRecords(output: string): {
  status: Array<Record<string, string>>;
  results: Array<Record<string, string>>;
} {
  const state: AndroidInstrumentationRecordState = {
    status: [],
    results: [],
    currentStatus: null,
    currentResult: null,
  };

  for (const line of output.split(/\r?\n/)) {
    readInstrumentationRecordLine(line, state);
  }
  flushInstrumentationRecords(state);
  return { status: state.status, results: state.results };
}

function readInstrumentationRecordLine(
  line: string,
  state: AndroidInstrumentationRecordState,
): void {
  if (line.startsWith('INSTRUMENTATION_STATUS: ')) {
    state.currentStatus ??= {};
    readKeyValue(line.slice('INSTRUMENTATION_STATUS: '.length), state.currentStatus);
    return;
  }
  if (line.startsWith('INSTRUMENTATION_STATUS_CODE: ')) {
    flushStatusRecord(state);
    return;
  }
  if (line.startsWith('INSTRUMENTATION_RESULT: ')) {
    state.currentResult ??= {};
    readKeyValue(line.slice('INSTRUMENTATION_RESULT: '.length), state.currentResult);
    return;
  }
  if (line.startsWith('INSTRUMENTATION_CODE: ')) {
    flushResultRecord(state);
  }
}

function flushInstrumentationRecords(state: AndroidInstrumentationRecordState): void {
  flushStatusRecord(state);
  flushResultRecord(state);
}

function flushStatusRecord(state: {
  status: Array<Record<string, string>>;
  currentStatus: Record<string, string> | null;
}): void {
  if (state.currentStatus) {
    state.status.push(state.currentStatus);
    state.currentStatus = null;
  }
}

function flushResultRecord(state: {
  results: Array<Record<string, string>>;
  currentResult: Record<string, string> | null;
}): void {
  if (state.currentResult) {
    state.results.push(state.currentResult);
    state.currentResult = null;
  }
}

function readKeyValue(line: string, target: Record<string, string>): void {
  const separator = line.indexOf('=');
  if (separator < 0) {
    return;
  }
  target[line.slice(0, separator)] = line.slice(separator + 1);
}

export function readInstrumentationResultNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readInstrumentationResultBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

export function readAndroidHelperManifestInteger(
  value: unknown,
  field: string,
  helperLabel: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AppError(
      'INVALID_ARGS',
      `Android ${helperLabel} manifest ${field} must be an integer.`,
    );
  }
  return value;
}

export function readAndroidHelperManifestLiteral<const Value extends string>(
  value: unknown,
  field: string,
  expected: Value,
  helperLabel: string,
): Value {
  if (value !== expected) {
    throw new AppError(
      'INVALID_ARGS',
      `Android ${helperLabel} manifest ${field} must be "${expected}".`,
    );
  }
  return expected;
}

export function readAndroidHelperManifestString(
  value: unknown,
  field: string,
  helperLabel: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_ARGS', `Android ${helperLabel} manifest ${field} is required.`);
  }
  return value;
}

export function readAndroidHelperManifestSha256(value: unknown, helperLabel: string): string {
  const sha256 = readAndroidHelperManifestString(value, 'sha256', helperLabel).trim().toLowerCase();
  if (sha256.length !== 64 || !/^[0-9a-f]+$/.test(sha256)) {
    throw new AppError(
      'INVALID_ARGS',
      `Android ${helperLabel} manifest sha256 must be a 64-character hex string.`,
    );
  }
  return sha256;
}
