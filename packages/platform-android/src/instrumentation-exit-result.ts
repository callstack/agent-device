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
const XML_MARKER_RE = /<\/?(?:\?xml|hierarchy|node)\b/;
// An attribute such as `text="…"` or `content-desc="…"` is snapshot content even when the
// element's opening tag was cut off or never printed.
const XML_ATTRIBUTE_RE = /\s[\w:.-]+="/;
// `android.util.AndroidException: INSTRUMENTATION_FAILED: <component>` and
// `onError: ... message=INSTRUMENTATION_FAILED: <component>` carry the marker mid-line.
const FAILED_RE = /INSTRUMENTATION_FAILED:[ \t]?(.*)$/;
const ABORTED_RE = /^INSTRUMENTATION_ABORTED:[ \t]?(.*)$/;
const RESULT_PREFIX = 'INSTRUMENTATION_RESULT: ';
const CODE_PREFIX = 'INSTRUMENTATION_CODE: ';
const PROTOCOL_RECORD_RE = /^INSTRUMENTATION_(?:STATUS|STATUS_CODE|RESULT|CODE|ABORTED|FAILED):/;

/**
 * Removes the app content a helper run may have printed: encoded snapshot payloads and XML in any
 * shape, including a fragment whose opening tag is missing. Instrumentation records and every other
 * line stay. This runs on the whole output, before any tail is cut from it.
 */
export function withoutSnapshotContent(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => {
      if (PROTOCOL_RECORD_RE.test(line)) {
        return line.replace(PAYLOAD_BASE64_RE, PAYLOAD_OMITTED).replace(XML_START_RE, XML_OMITTED);
      }
      if (XML_MARKER_RE.test(line) || XML_ATTRIBUTE_RE.test(line)) return XML_OMITTED;
      return line.replace(PAYLOAD_BASE64_RE, PAYLOAD_OMITTED);
    })
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
  // Snapshot content is removed per line as it completes, so the bounded window never holds a
  // line whose opening tag was cut away. A line too long to hold is dropped as snapshot content.
  let kept = '';
  let pending = '';
  let pendingDropped = false;
  const keep = (line: string) => {
    kept = `${kept}${withoutSnapshotContent(line)}\n`.slice(-OUTPUT_SCAN_MAX_CHARS);
  };
  const onData = (chunk: Buffer | string) => {
    const lines = (pending + chunk.toString()).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      keep(pendingDropped ? XML_OMITTED : line);
      pendingDropped = false;
    }
    if (pending.length > OUTPUT_SCAN_MAX_CHARS) {
      pending = '';
      pendingDropped = true;
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
          })
        : undefined,
  };
}
