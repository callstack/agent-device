import { REDACTED_STRING_MAX_LENGTH, redactDiagnosticText } from '@agent-device/kernel/redaction';
import type { AndroidAdbProcess } from './adb-executor.ts';

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
  outputTruncated: boolean;
};

const OUTPUT_SCAN_MAX_CHARS = 16_384;
const MESSAGE_FIELD_MAX_CHARS = 2_048;
const PAYLOAD_OMITTED = 'payloadBase64=<omitted>';
const XML_OMITTED = '<snapshot xml omitted>';
const PAYLOAD_BASE64_RE = /payloadBase64=\S*/g;
const XML_START_RE = /<(?:\?xml|hierarchy|node)\b.*/g;
const XML_ELEMENT_LINE_RE = /^\s*<\/?(?:hierarchy|node)\b/;
// `android.util.AndroidException: INSTRUMENTATION_FAILED: <component>` and
// `onError: ... message=INSTRUMENTATION_FAILED: <component>` carry the marker mid-line.
const FAILED_RE = /INSTRUMENTATION_FAILED:[ \t]?(.*)$/;
const ABORTED_RE = /^INSTRUMENTATION_ABORTED:[ \t]?(.*)$/;
const RESULT_PREFIX = 'INSTRUMENTATION_RESULT: ';
const CODE_PREFIX = 'INSTRUMENTATION_CODE: ';
const PROTOCOL_RECORD_RE = /^INSTRUMENTATION_(?:STATUS|STATUS_CODE|RESULT|CODE|ABORTED|FAILED):/;

/**
 * Removes the app content a helper run may have printed: encoded snapshot payloads and raw XML,
 * including a fragment cut off mid-element. Instrumentation records and every other line stay.
 */
export function withoutSnapshotContent(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !XML_ELEMENT_LINE_RE.test(line))
    .map((line) =>
      line.replace(PAYLOAD_BASE64_RE, PAYLOAD_OMITTED).replace(XML_START_RE, XML_OMITTED),
    )
    .join('\n');
}

export function readInstrumentationExitResult(run: {
  stdout: string;
  stderr: string;
  exitCode: number | null | undefined;
  signal?: string | null;
}): AndroidInstrumentationExitResult {
  const streams = [run.stdout, run.stderr].filter(Boolean).map(withoutSnapshotContent);
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
      text.length > REDACTED_STRING_MAX_LENGTH || output.length > OUTPUT_SCAN_MAX_CHARS,
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
    fields[key] = record.slice(separator + 1);
    return key;
  }
  if (line.startsWith(CODE_PREFIX)) {
    const code = line.slice(CODE_PREFIX.length).trim();
    if (/^-?\d+$/.test(code)) fields.resultCode ??= Number(code);
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
  /** The process's exit result, or `undefined` while it is running. */
  exitResult(): AndroidInstrumentationExitResult | undefined;
};

export function recordInstrumentationProcess(
  process: AndroidAdbProcess,
): AndroidInstrumentationProcessRecord {
  let output = '';
  const onData = (chunk: Buffer | string) => {
    output = (output + chunk.toString()).slice(-OUTPUT_SCAN_MAX_CHARS);
  };
  process.stdout?.on('data', onData);
  process.stderr?.on('data', onData);
  return {
    exitResult: () =>
      process.exitCode == null && process.signalCode == null
        ? undefined
        : readInstrumentationExitResult({
            stdout: output,
            stderr: '',
            exitCode: process.exitCode,
            signal: process.signalCode,
          }),
  };
}
