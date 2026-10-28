// Shared primitives for the Android instrumentation helpers (snapshot + multi-touch).
// Both helpers drive `am instrument -w` and parse the resulting
// INSTRUMENTATION_STATUS / INSTRUMENTATION_RESULT key/value records, and both
// validate a bundled JSON manifest with the same integer/literal field rules.

type AndroidInstrumentationRecordState = {
  status: Array<Record<string, string>>;
  results: Array<Record<string, string>>;
  currentStatus: Record<string, string> | null;
  currentResult: Record<string, string> | null;
  resultCode?: number;
  aborted?: string;
  failed?: string;
};

export function parseInstrumentationRecords(output: string): {
  status: Array<Record<string, string>>;
  results: Array<Record<string, string>>;
  /** `INSTRUMENTATION_CODE`, the instrumentation's own result code. */
  resultCode?: number;
  /** `INSTRUMENTATION_ABORTED`: the system ended the run before it reported. */
  aborted?: string;
  /** `INSTRUMENTATION_FAILED`: the run never started. */
  failed?: string;
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
  return {
    status: state.status,
    results: state.results,
    ...(state.resultCode !== undefined ? { resultCode: state.resultCode } : {}),
    ...(state.aborted !== undefined ? { aborted: state.aborted } : {}),
    ...(state.failed !== undefined ? { failed: state.failed } : {}),
  };
}

/** Bound on the raw output a failed run keeps: enough for a crash report, never a whole snapshot. */
const INSTRUMENTATION_OUTPUT_TAIL_MAX_CHARS = 4_096;

/**
 * What an `am instrument` run that returned no usable report says about its own end. Every field is
 * a value the instrumentation or the host process printed or exited with; absent fields were not
 * printed.
 */
export type AndroidInstrumentationExitResult = {
  /** Host process exit status; `null` when a signal ended it. */
  exitCode: number | null;
  signal?: string;
  resultCode?: number;
  aborted?: string;
  failed?: string;
  shortMsg?: string;
  longMsg?: string;
  outputTail: string;
  outputTruncated: boolean;
};

export function readInstrumentationExitResult(run: {
  stdout: string;
  stderr: string;
  exitCode: number | null | undefined;
  signal?: string | null;
}): AndroidInstrumentationExitResult {
  const output = [run.stdout, run.stderr].filter(Boolean).join('\n');
  const records = parseInstrumentationRecords(output);
  const shortMsg = findInstrumentationResultField(records.results, 'shortMsg');
  const longMsg = findInstrumentationResultField(records.results, 'longMsg');
  return {
    exitCode: run.exitCode ?? null,
    ...(run.signal ? { signal: run.signal } : {}),
    ...(records.resultCode !== undefined ? { resultCode: records.resultCode } : {}),
    ...(records.aborted !== undefined ? { aborted: records.aborted } : {}),
    ...(records.failed !== undefined ? { failed: records.failed } : {}),
    ...(shortMsg !== undefined ? { shortMsg } : {}),
    ...(longMsg !== undefined ? { longMsg } : {}),
    outputTail: output.slice(-INSTRUMENTATION_OUTPUT_TAIL_MAX_CHARS),
    outputTruncated: output.length > INSTRUMENTATION_OUTPUT_TAIL_MAX_CHARS,
  };
}

function findInstrumentationResultField(
  results: Array<Record<string, string>>,
  key: string,
): string | undefined {
  return results.find((record) => record[key] !== undefined)?.[key];
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
    state.resultCode = readInstrumentationResultNumber(
      line.slice('INSTRUMENTATION_CODE: '.length).trim(),
    );
    flushResultRecord(state);
    return;
  }
  if (line.startsWith('INSTRUMENTATION_ABORTED: ')) {
    state.aborted = line.slice('INSTRUMENTATION_ABORTED: '.length);
    return;
  }
  if (line.startsWith('INSTRUMENTATION_FAILED: ')) {
    state.failed = line.slice('INSTRUMENTATION_FAILED: '.length);
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

/**
 * A comma-separated list of non-negative decimal integers; an empty value is an empty list, and any
 * entry that is not plain decimal digits (an empty entry, hex, a sign, a fraction) makes it absent.
 */
export function readInstrumentationResultIntegerList(
  value: string | undefined,
): number[] | undefined {
  if (value === undefined) return undefined;
  if (value === '') return [];
  const entries = value.split(',');
  return entries.every((entry) => /^\d+$/.test(entry)) ? entries.map(Number) : undefined;
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

export {
  readAndroidHelperManifestInteger,
  readAndroidHelperManifestLiteral,
} from './helper-artifacts.ts';
