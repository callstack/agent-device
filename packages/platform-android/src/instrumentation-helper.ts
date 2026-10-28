import { REDACTED_STRING_MAX_LENGTH, redactDiagnosticText } from '@agent-device/kernel/redaction';
import type { AndroidAdbProcess } from './adb-executor.ts';
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

/**
 * What an `am instrument` run that returned no usable report says about its own end. Every field is
 * a value the instrumentation or the host process printed or exited with; an absent field was not
 * printed.
 */
export type AndroidInstrumentationExitResult = {
  /** Host process exit status; `null` when a signal ended it. */
  exitCode: number | null;
  signal?: string;
  /** `INSTRUMENTATION_CODE`. */
  resultCode?: number;
  /** `INSTRUMENTATION_ABORTED`: the system ended the run before it reported. */
  aborted?: string;
  /** `INSTRUMENTATION_FAILED`: the run never started. */
  failed?: string;
  shortMsg?: string;
  longMsg?: string;
  /**
   * The end of the output after snapshot content is removed and secrets are redacted, held to the
   * length a redacted diagnostic string keeps so the cause at the end is what survives the
   * boundary.
   */
  outputTail: string;
  /** Output was cut, or snapshot content was removed from it. */
  outputTruncated: boolean;
  /** Lines holding snapshot content were removed, so the tail is a filtered view of the output. */
  snapshotContentRemoved?: true;
};

const OUTPUT_SCAN_MAX_CHARS = 16_384;
const MESSAGE_FIELD_MAX_CHARS = 2_048;
const PAYLOAD_OMITTED = 'payloadBase64=<omitted>';
const XML_OMITTED = '<snapshot xml omitted>';
const PAYLOAD_BASE64_RE = /payloadBase64=\S*/g;
const XML_START_RE = /<(?:\?xml|hierarchy|node)\b.*/g;
// A UiAutomator hierarchy dump prints `<node` and `<hierarchy` elements whose attributes carry the
// app's text. An attribute of the dump is snapshot content even when its element's opening tag was
// cut off or never printed; any other quoted assignment is ordinary output.
const XML_ELEMENT_RE = /<\/?(?:\?xml|hierarchy|node)\b/;
const XML_ATTRIBUTE_RE =
  /(?<![\w-])(?:text|content-desc|resource-id|bounds|hint|package|class|checkable|clickable)="/;
// `android.util.AndroidException: INSTRUMENTATION_FAILED: <component>` and
// `onError: ... message=INSTRUMENTATION_FAILED: <component>` carry the marker mid-line.
const FAILED_RE = /INSTRUMENTATION_FAILED:[ \t]?(.*)$/;
const ABORTED_RE = /^INSTRUMENTATION_ABORTED:[ \t]?(.*)$/;
const RESULT_PREFIX = 'INSTRUMENTATION_RESULT: ';
const CODE_PREFIX = 'INSTRUMENTATION_CODE: ';
const PROTOCOL_RECORD_RE = /^INSTRUMENTATION_(?:STATUS|STATUS_CODE|RESULT|CODE|ABORTED|FAILED):/;

function holdsSnapshotContent(line: string): boolean {
  return (
    XML_ELEMENT_RE.test(line) || XML_ATTRIBUTE_RE.test(line) || line.includes('payloadBase64=')
  );
}

/**
 * Removes the app content a helper run may have printed: encoded snapshot payloads and XML in any
 * shape, including a fragment whose opening tag is missing. Instrumentation records and every other
 * line stay. This runs on the whole output, before any tail is cut from it.
 */
function filterSnapshotContent(output: string): { text: string; removed: boolean } {
  let removed = false;
  const text = output
    .split(/\r?\n/)
    .map((line) => {
      if (!holdsSnapshotContent(line)) return line;
      removed = true;
      if (PROTOCOL_RECORD_RE.test(line)) {
        return line.replace(PAYLOAD_BASE64_RE, PAYLOAD_OMITTED).replace(XML_START_RE, XML_OMITTED);
      }
      return XML_ELEMENT_RE.test(line) || XML_ATTRIBUTE_RE.test(line)
        ? XML_OMITTED
        : line.replace(PAYLOAD_BASE64_RE, PAYLOAD_OMITTED);
    })
    .join('\n');
  return { text, removed };
}

export function withoutSnapshotContent(output: string): string {
  return filterSnapshotContent(output).text;
}

export function readInstrumentationExitResult(run: {
  stdout: string;
  stderr: string;
  exitCode: number | null | undefined;
  signal?: string | null;
  /** What a caller that already filtered or cut the output before handing it over has done to it. */
  prior?: { snapshotContentRemoved: boolean; cut: boolean };
}): AndroidInstrumentationExitResult {
  const filtered = [run.stdout, run.stderr].filter(Boolean).map(filterSnapshotContent);
  const streams = filtered.map((stream) => stream.text);
  const snapshotContentRemoved =
    filtered.some((stream) => stream.removed) || run.prior?.snapshotContentRemoved === true;
  const fields = streams.reduce<InstrumentationFields>(
    (found, stream) => scanInstrumentationFields(stream, found),
    {},
  );
  const output = streams.join('\n');
  const text = redactDiagnosticText(output.slice(-OUTPUT_SCAN_MAX_CHARS));
  return {
    exitCode: run.exitCode ?? null,
    ...(run.signal ? { signal: run.signal } : {}),
    ...fields,
    outputTail: text.slice(-REDACTED_STRING_MAX_LENGTH),
    outputTruncated:
      text.length > REDACTED_STRING_MAX_LENGTH ||
      output.length > OUTPUT_SCAN_MAX_CHARS ||
      snapshotContentRemoved ||
      run.prior?.cut === true,
    ...(snapshotContentRemoved ? { snapshotContentRemoved: true as const } : {}),
  };
}

type InstrumentationFields = Partial<
  Pick<
    AndroidInstrumentationExitResult,
    'resultCode' | 'aborted' | 'failed' | 'shortMsg' | 'longMsg'
  >
>;

/**
 * Reads the run's own end from one stream. AOSP prints a bundle value as it is, so a value with
 * newlines spans lines: the lines after `shortMsg=` or `longMsg=` belong to it until the next
 * protocol record. Fields already found in an earlier stream win.
 */
function scanInstrumentationFields(
  output: string,
  found: InstrumentationFields,
): InstrumentationFields {
  const fields: InstrumentationFields = { ...found };
  let open: MessageField | undefined;
  for (const line of output.split(/\r?\n/)) {
    const failed = FAILED_RE.exec(line);
    if (failed) {
      fields.failed ??= (failed[1] ?? '').trim();
      open = undefined;
    } else if (PROTOCOL_RECORD_RE.test(line)) {
      open = readProtocolRecord(line, fields);
    } else if (open) {
      fields[open] = appendLine(fields[open], line);
    }
  }
  for (const key of ['shortMsg', 'longMsg'] as const) {
    if (fields[key] !== undefined) fields[key] = fields[key].trimEnd();
  }
  return fields;
}

type MessageField = 'shortMsg' | 'longMsg';

/** Records what a protocol line states; answers the message field whose value it opens. */
function readProtocolRecord(line: string, fields: InstrumentationFields): MessageField | undefined {
  if (line.startsWith(RESULT_PREFIX)) {
    const record = line.slice(RESULT_PREFIX.length);
    const separator = record.indexOf('=');
    const key = record.slice(0, separator);
    if ((key !== 'shortMsg' && key !== 'longMsg') || fields[key] !== undefined) return undefined;
    fields[key] = record.slice(separator + 1, separator + 1 + MESSAGE_FIELD_MAX_CHARS);
    return key;
  }
  if (line.startsWith(CODE_PREFIX)) {
    const code = line.slice(CODE_PREFIX.length).trim();
    if (/^-?\d+$/.test(code) && Number.isSafeInteger(Number(code))) {
      fields.resultCode ??= Number(code);
    }
    return undefined;
  }
  const aborted = ABORTED_RE.exec(line);
  if (aborted) fields.aborted ??= (aborted[1] ?? '').trim();
  return undefined;
}

function appendLine(value: string | undefined, line: string): string | undefined {
  const next = `${value ?? ''}\n${line}`;
  return next.length > MESSAGE_FIELD_MAX_CHARS ? value : next;
}

/** The exit of a spawned helper process and what it printed, kept to a bounded recent window. */
export type AndroidInstrumentationProcessRecord = {
  /** Settles when the process's output streams have closed, the point its output is complete. */
  closed: Promise<void>;
  /** The process's exit result once its streams have closed, or `undefined` before that. */
  exitResult(): AndroidInstrumentationExitResult | undefined;
};

export function recordInstrumentationProcess(
  child: AndroidAdbProcess,
): AndroidInstrumentationProcessRecord {
  // Each line is filtered as it completes, so the bounded window never holds a line whose opening
  // tag was cut away. A line that outgrows the window is classified on the part held: snapshot
  // content is dropped, anything else keeps its end.
  let kept = '';
  let pending = '';
  let pendingDropped = false;
  const prior = { snapshotContentRemoved: false, cut: false };
  const keep = (line: string) => {
    const filtered = filterSnapshotContent(line);
    prior.snapshotContentRemoved ||= filtered.removed;
    const next = `${kept}${filtered.text}\n`;
    prior.cut ||= next.length > OUTPUT_SCAN_MAX_CHARS;
    kept = next.slice(-OUTPUT_SCAN_MAX_CHARS);
  };
  const onData = (chunk: Buffer | string) => {
    const lines = (pending + chunk.toString()).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      keep(pendingDropped ? XML_OMITTED : line);
      pendingDropped = false;
    }
    if (pending.length > OUTPUT_SCAN_MAX_CHARS) {
      pendingDropped ||= holdsSnapshotContent(pending);
      pending = pendingDropped ? '' : pending.slice(-OUTPUT_SCAN_MAX_CHARS);
      prior.cut = true;
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  let isClosed = false;
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      isClosed = true;
      resolve();
    });
  });
  return {
    closed,
    exitResult: () =>
      isClosed
        ? readInstrumentationExitResult({
            stdout: pendingDropped ? `${kept}${XML_OMITTED}` : `${kept}${pending}`,
            stderr: '',
            exitCode: child.exitCode,
            signal: child.signalCode,
            prior,
          })
        : undefined,
  };
}

export {
  readAndroidHelperManifestInteger,
  readAndroidHelperManifestLiteral,
} from './helper-artifacts.ts';
