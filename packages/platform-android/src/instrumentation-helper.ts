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
 * What an `am instrument` run that returned no usable report says about its own end.
 *
 * Private by construction: stdout contributes only the protocol fields parsed below and never a line
 * of its own, so a snapshot payload or raw XML the helper printed has no way in. The only free text
 * is a bounded stderr tail, from which lines holding snapshot content are removed.
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
  /** `INSTRUMENTATION_FAILED`: the run never started. */
  failed?: string;
  shortMsg?: string;
  longMsg?: string;
  error?: string;
  stack?: string;
  /**
   * The end of stderr after secrets are redacted, held to the length a redacted diagnostic string
   * keeps so the cause at the end is what survives the boundary.
   */
  stderrTail: string;
  /** Stderr was cut, or a line of it was removed as snapshot content. */
  stderrTruncated: boolean;
  /** A line of either stream held snapshot content and was dropped. */
  snapshotContentRemoved?: true;
};

const STDERR_WINDOW_MAX_CHARS = 16_384;
const STDOUT_LINE_MAX_CHARS = 4_096;
// A line is held to a few times the tail that survives the diagnostic boundary.
const STDERR_LINE_MAX_CHARS = 1_024;
const MESSAGE_FIELD_MAX_CHARS = 2_048;
const SNAPSHOT_OMITTED = '<snapshot content omitted>';
// A UiAutomator hierarchy dump prints `<node` and `<hierarchy` elements whose attributes carry the
// app's text. An attribute of the dump is snapshot content even when its element's opening tag was
// cut off or never printed; any other quoted assignment is ordinary output.
const SNAPSHOT_CONTENT_RE =
  /<\/?(?:\?xml|hierarchy|node)\b|(?<![\w-])(?:text|content-desc|resource-id|bounds|hint|package|class|checkable|clickable)="|payloadBase64=/;
// `android.util.AndroidException: INSTRUMENTATION_FAILED: <component>` and
// `onError: ... message=INSTRUMENTATION_FAILED: <component>` carry the marker mid-line.
const FAILED_RE = /INSTRUMENTATION_FAILED:[ \t]?(.*)$/;
const ABORTED_RE = /^INSTRUMENTATION_ABORTED:[ \t]?(.*)$/;
const PROTOCOL_RECORD_RE = /^INSTRUMENTATION_(?:STATUS|STATUS_CODE|RESULT|CODE|ABORTED|FAILED):/;
const VALUE_RECORD_RE = /^INSTRUMENTATION_(?:STATUS|RESULT): ([^=]*)=(.*)$/;
const CODE_RE = /^INSTRUMENTATION_(STATUS_CODE|CODE): (-?\d+)\s*$/;
// The protocol keys whose values are text, by the field they fill.
const MESSAGE_FIELDS = { shortMsg: 'shortMsg', longMsg: 'longMsg', Error: 'error', stack: 'stack' };
type MessageField = 'shortMsg' | 'longMsg' | 'error' | 'stack';

type LineAssembler = { write(chunk: string): void; end(): void };

/**
 * Splits one stream into lines. A line longer than `maxChars` keeps its head or its tail, and is
 * reported as snapshot content if any part of it that was held at some point looked like it.
 */
function createLineAssembler(
  keep: 'head' | 'tail',
  maxChars: number,
  onLine: (line: string, snapshot: boolean, cut: boolean) => void,
): LineAssembler {
  let pending = '';
  let snapshot = false;
  let cut = false;
  const append = (text: string) => {
    pending += text;
    if (pending.length <= maxChars) return;
    snapshot ||= SNAPSHOT_CONTENT_RE.test(pending);
    cut = true;
    pending = keep === 'head' ? pending.slice(0, maxChars) : startAtToken(pending.slice(-maxChars));
  };
  const flush = () => {
    const line = pending.replace(/\r$/, '');
    onLine(line, snapshot || SNAPSHOT_CONTENT_RE.test(line), cut);
    pending = '';
    snapshot = false;
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
      if (pending || cut || snapshot) flush();
    },
  };
}

/** Drops the token a tail cut landed in, so a redaction key is never left without its name. */
function startAtToken(text: string): string {
  const boundary = /\s/.exec(text);
  return boundary ? text.slice(boundary.index + 1) : '';
}

/** One run's output, read as two streams with a parser state each. */
function createInstrumentationOutput() {
  const fields: Partial<
    Record<MessageField | 'aborted' | 'failed', string> &
      Record<'resultCode' | 'statusCode', number>
  > = {};
  let open: MessageField | undefined;
  let snapshotContentRemoved = false;
  let stderrKept = '';
  let stderrCut = false;
  const accept = (text: string, snapshot: boolean): string | undefined => {
    snapshotContentRemoved ||= snapshot;
    return snapshot ? undefined : text;
  };
  const readFailed = (line: string) => {
    const failed = FAILED_RE.exec(line);
    if (failed) fields.failed ??= accept((failed[1] ?? '').trim(), SNAPSHOT_CONTENT_RE.test(line));
    return failed !== null;
  };
  const readStdoutLine = (line: string, snapshot: boolean) => {
    if (readFailed(line)) {
      open = undefined;
    } else if (PROTOCOL_RECORD_RE.test(line)) {
      open = readProtocolRecord(line, snapshot);
    } else if (!open) {
      snapshotContentRemoved ||= snapshot;
    } else if (accept(line, snapshot) !== undefined) {
      fields[open] = appendLine(fields[open], line);
    }
  };
  /** Reads one protocol record; answers the message field its value opens, if any. */
  const readProtocolRecord = (line: string, snapshot: boolean): MessageField | undefined => {
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
      fields.aborted ??= accept((aborted[1] ?? '').trim(), snapshot);
      return undefined;
    }
    const record = VALUE_RECORD_RE.exec(line);
    const field = record ? messageFieldOf(record[1]!) : undefined;
    if (!field || fields[field] !== undefined) {
      snapshotContentRemoved ||= snapshot;
      return undefined;
    }
    const value = accept((record![2] ?? '').slice(0, MESSAGE_FIELD_MAX_CHARS), snapshot);
    if (value === undefined) return undefined;
    fields[field] = value;
    return field;
  };
  const readStderrLine = (line: string, snapshot: boolean, cut: boolean) => {
    readFailed(line);
    stderrCut ||= cut || snapshot;
    snapshotContentRemoved ||= snapshot;
    stderrKept += `${snapshot ? SNAPSHOT_OMITTED : line}\n`;
    if (stderrKept.length > STDERR_WINDOW_MAX_CHARS) {
      stderrCut = true;
      stderrKept = stderrKept.slice(
        stderrKept.indexOf('\n', stderrKept.length - STDERR_WINDOW_MAX_CHARS) + 1,
      );
    }
  };
  const stdout = createLineAssembler('head', STDOUT_LINE_MAX_CHARS, readStdoutLine);
  const stderr = createLineAssembler('tail', STDERR_LINE_MAX_CHARS, readStderrLine);
  return {
    writeStdout: stdout.write,
    writeStderr: stderr.write,
    result(
      exitCode: number | null | undefined,
      signal: string | null | undefined,
      final: boolean,
    ): AndroidInstrumentationExitResult {
      if (final) {
        stdout.end();
        stderr.end();
      }
      const text = redactDiagnosticText(stderrKept);
      const { aborted, failed, shortMsg, longMsg, error, stack, resultCode, statusCode } = fields;
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
        stderrTail: text.slice(-REDACTED_STRING_MAX_LENGTH),
        stderrTruncated: stderrCut || text.length > REDACTED_STRING_MAX_LENGTH,
        ...(snapshotContentRemoved ? { snapshotContentRemoved: true as const } : {}),
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

/** The exit of a spawned helper process and what it printed, kept to a bounded recent window. */
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
