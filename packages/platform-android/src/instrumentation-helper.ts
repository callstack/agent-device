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
 * What an `am instrument` run that returned no usable report says about its own end.
 *
 * Private by construction: no line of either stream is copied. The fields below are parsed from
 * stdout protocol records, plus the startup-failure component from a strict whole-line envelope on
 * either stream. A snapshot payload or raw XML the helper printed has no way in.
 */
export type AndroidInstrumentationExitResult = {
  /** Host process exit status; `null` when a signal ended it. */
  exitCode: number | null;
  signal?: string;
  /** `INSTRUMENTATION_CODE`. */
  resultCode?: number;
  /** The last `INSTRUMENTATION_STATUS_CODE`. */
  statusCode?: number;
  /** `INSTRUMENTATION_ABORTED`: the system ended the run before it reported. */
  aborted?: string;
  /** The component of `INSTRUMENTATION_FAILED`: the run never started. */
  failed?: string;
  shortMsg?: string;
  longMsg?: string;
  error?: string;
  stack?: string;
  /** Fields dropped whole because their value held a snapshot marker. */
  withheldFields?: Array<MessageField | 'aborted'>;
};

const LINE_MAX_CHARS = 4_096;
const MESSAGE_FIELD_MAX_CHARS = 2_048;
// A startup failure is read only from a whole line of one of the three shapes AOSP prints; a
// component name has no space, quote or angle bracket, so a line holding any other text cannot match.
const COMPONENT = '([A-Za-z0-9_.$/]*)';
const FAILED_ENVELOPES = [
  new RegExp(`^INSTRUMENTATION_FAILED: ?${COMPONENT}$`),
  new RegExp(`^android\\.util\\.AndroidException: INSTRUMENTATION_FAILED: ${COMPONENT}$`),
  new RegExp(`^onError: commandError=(?:true|false) message=INSTRUMENTATION_FAILED: ${COMPONENT}$`),
];
// Attributes `AccessibilityTreeXml` writes. A value that holds one in `name="` form, a tag
// bracket, or a payload record is withheld whole rather than filtered.
const SNAPSHOT_ATTRIBUTES = [
  'bounds',
  'checked',
  'class',
  'clickable',
  'content-desc',
  'drawing-order',
  'editable',
  'enabled',
  'focusable',
  'focused',
  'heading',
  'hint',
  'hint-showing',
  'index',
  'package',
  'password',
  'resource-id',
  'role-description',
  'scrollable',
  'selected',
  'selection-end',
  'selection-start',
  'text',
  'visible-to-user',
  'window-active',
  'window-focused',
  'window-index',
  'window-layer',
  'window-region-rect',
  'window-type',
];
const SNAPSHOT_MARKER_RE = new RegExp(
  `<|/>|payloadBase64|(?<![\\w-])(?:${SNAPSHOT_ATTRIBUTES.join('|')})="`,
);

/** A JVM constructor name is not an element; every other `<` is a snapshot marker. */
function holdsSnapshotMarker(text: string): boolean {
  return SNAPSHOT_MARKER_RE.test(text.replaceAll('<init>', '').replaceAll('<clinit>', ''));
}

const ABORTED_RE = /^INSTRUMENTATION_ABORTED:[ \t]?(.*)$/;
const PROTOCOL_RECORD_RE = /^INSTRUMENTATION_(?:STATUS|STATUS_CODE|RESULT|CODE|ABORTED|FAILED):/;
const VALUE_RECORD_RE = /^INSTRUMENTATION_(?:STATUS|RESULT): ([^=]*)=(.*)$/;
const CODE_RE = /^INSTRUMENTATION_(STATUS_CODE|CODE): (-?\d+)\s*$/;
// The protocol keys whose values are text, by the field they fill.
const MESSAGE_FIELDS = { shortMsg: 'shortMsg', longMsg: 'longMsg', Error: 'error', stack: 'stack' };
type MessageField = 'shortMsg' | 'longMsg' | 'error' | 'stack';

type LineAssembler = { write(chunk: string): void; end(): void };

/** Splits one stream into lines; a line longer than `LINE_MAX_CHARS` keeps its head and is reported as cut. */
function createLineAssembler(onLine: (line: string, cut: boolean) => void): LineAssembler {
  let pending = '';
  let cut = false;
  const append = (text: string) => {
    pending += text;
    if (pending.length <= LINE_MAX_CHARS) return;
    cut = true;
    pending = pending.slice(0, LINE_MAX_CHARS);
  };
  const flush = () => {
    onLine(pending.replace(/\r$/, ''), cut);
    pending = '';
    cut = false;
  };
  return {
    write(chunk) {
      let rest = chunk;
      for (let newline = rest.indexOf('\n'); newline >= 0; newline = rest.indexOf('\n')) {
        append(rest.slice(0, newline));
        flush();
        rest = rest.slice(newline + 1);
      }
      append(rest);
    },
    end() {
      if (pending) flush();
    },
  };
}

/** One run's output, read as two streams with a parser state each. */
function createInstrumentationOutput() {
  const fields: Partial<
    Record<MessageField | 'aborted' | 'failed', string> &
      Record<'resultCode' | 'statusCode', number>
  > = {};
  let open: MessageField | undefined;
  const withheld = new Set<MessageField | 'aborted'>();
  const checked = (field: MessageField | 'aborted', text: string) => {
    if (holdsSnapshotMarker(text)) withheld.add(field);
    return text;
  };
  const readFailed = (line: string, cut: boolean): boolean => {
    if (cut) return false;
    for (const envelope of FAILED_ENVELOPES) {
      const match = envelope.exec(line);
      if (match) {
        fields.failed ??= match[1] ?? '';
        return true;
      }
    }
    return false;
  };
  const readStdoutLine = (line: string, cut: boolean) => {
    if (readFailed(line, cut)) {
      open = undefined;
    } else if (PROTOCOL_RECORD_RE.test(line)) {
      open = readProtocolRecord(line);
    } else if (open) {
      fields[open] = appendLine(fields[open], checked(open, line));
    }
  };
  /** Reads one protocol record; answers the message field whose value it opens, if any. */
  const readProtocolRecord = (line: string): MessageField | undefined => {
    const code = CODE_RE.exec(line);
    if (code) {
      const value = Number(code[2]);
      if (!Number.isSafeInteger(value)) return undefined;
      if (code[1] === 'CODE') fields.resultCode ??= value;
      else fields.statusCode = value;
      return undefined;
    }
    const aborted = ABORTED_RE.exec(line);
    if (aborted) {
      fields.aborted ??= checked('aborted', (aborted[1] ?? '').trim());
      return undefined;
    }
    const record = VALUE_RECORD_RE.exec(line);
    const field = record ? messageFieldOf(record[1]!) : undefined;
    if (!field || fields[field] !== undefined) return undefined;
    fields[field] = checked(field, record![2] ?? '').slice(0, MESSAGE_FIELD_MAX_CHARS);
    return field;
  };
  const stdout = createLineAssembler(readStdoutLine);
  const stderr = createLineAssembler(readFailed);
  return {
    writeStdout: stdout.write,
    writeStderr: stderr.write,
    /** Finalizing reads the line still being written; a snapshot of a live process does not. */
    result(
      exitCode: number | null | undefined,
      signal: string | null | undefined,
      final: boolean,
    ): AndroidInstrumentationExitResult {
      if (final) {
        stdout.end();
        stderr.end();
      }
      const shown = { ...fields };
      for (const field of withheld) delete shown[field];
      const { aborted, failed, shortMsg, longMsg, error, stack, resultCode, statusCode } = shown;
      return {
        exitCode: exitCode ?? null,
        ...(signal ? { signal } : {}),
        ...(resultCode !== undefined ? { resultCode } : {}),
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(aborted !== undefined ? { aborted } : {}),
        ...(failed !== undefined ? { failed } : {}),
        ...(shortMsg !== undefined ? { shortMsg: shortMsg.trimEnd() } : {}),
        ...(longMsg !== undefined ? { longMsg: longMsg.trimEnd() } : {}),
        ...(error !== undefined ? { error: error.trimEnd() } : {}),
        ...(stack !== undefined ? { stack: stack.trimEnd() } : {}),
        ...(withheld.size > 0 ? { withheldFields: [...withheld].sort() } : {}),
      };
    },
  };
}

function messageFieldOf(key: string): MessageField | undefined {
  return Object.hasOwn(MESSAGE_FIELDS, key)
    ? (MESSAGE_FIELDS[key as keyof typeof MESSAGE_FIELDS] as MessageField)
    : undefined;
}

function appendLine(value: string | undefined, line: string): string | undefined {
  const next = `${value ?? ''}\n${line}`;
  return next.length > MESSAGE_FIELD_MAX_CHARS ? value : next;
}

export function readInstrumentationExitResult(run: {
  stdout: string;
  stderr: string;
  exitCode: number | null | undefined;
  signal?: string | null;
}): AndroidInstrumentationExitResult {
  const output = createInstrumentationOutput();
  output.writeStdout(run.stdout);
  output.writeStderr(run.stderr);
  return output.result(run.exitCode, run.signal, true);
}

/** The exit of a spawned helper process and what it printed. */
export type AndroidInstrumentationProcessRecord = {
  /** Settles when the process's output streams have closed, the point its output is complete. */
  closed: Promise<void>;
  /** The process's exit result once its streams have closed, or `undefined` before that. */
  exitResult(): AndroidInstrumentationExitResult | undefined;
  /**
   * What the process has printed so far, for a process that is still running. A line still being
   * written is left out, and the record keeps reading it.
   */
  current(): AndroidInstrumentationExitResult;
};

export function recordInstrumentationProcess(
  child: AndroidAdbProcess,
): AndroidInstrumentationProcessRecord {
  const output = createInstrumentationOutput();
  const listen = (stream: AndroidAdbProcess['stdout'], write: (chunk: string) => void) => {
    const decoder = new TextDecoder();
    stream?.on('data', (chunk: Buffer | string) => {
      write(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    });
  };
  listen(child.stdout, output.writeStdout);
  listen(child.stderr, output.writeStderr);
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
      isClosed ? output.result(child.exitCode, child.signalCode, true) : undefined,
    current: () => output.result(child.exitCode, child.signalCode, false),
  };
}

export {
  readAndroidHelperManifestInteger,
  readAndroidHelperManifestLiteral,
} from './helper-artifacts.ts';
