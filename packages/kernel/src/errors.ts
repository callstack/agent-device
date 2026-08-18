import { redactDiagnosticData } from './redaction.ts';

/**
 * The known error codes as a value, so gates can enumerate them: every code
 * here must resolve a hint through `defaultHintForCode`, and every code
 * `retriableForErrorCode` classifies must have a recovery quiz in the help
 * benchmark (scripts/__tests__/help-conformance-error-recovery-coverage.test.ts).
 * `KnownAppErrorCode` is derived from this array, so a new code cannot be added
 * to the type without entering the enumeration.
 */
export const KNOWN_APP_ERROR_CODES = [
  'INVALID_ARGS',
  'DEVICE_NOT_FOUND',
  'DEVICE_IN_USE',
  'TOOL_MISSING',
  'APP_NOT_INSTALLED',
  'UNSUPPORTED_PLATFORM',
  'UNSUPPORTED_OPERATION',
  'NOT_IMPLEMENTED',
  'COMMAND_FAILED',
  'SESSION_NOT_FOUND',
  'UNAUTHORIZED',
  'AMBIGUOUS_MATCH',
  'REPLAY_DIVERGENCE',
  'REPAIR_SESSION_EXPIRED',
  'REPAIR_COMMIT_FAILED',
  'UNKNOWN',
] as const;

export type KnownAppErrorCode = (typeof KNOWN_APP_ERROR_CODES)[number];

// Intentionally widened with `(string & {})` so daemon-originated codes pass
// through verbatim without requiring the SDK union to be updated first. Known
// codes still autocomplete in IDEs. Tradeoff: `switch (err.code)` is no longer
// exhaustive by construction — SDK consumers handling unknown codes should
// include a default branch.
export type AppErrorCode = KnownAppErrorCode | (string & {});

export function toAppErrorCode(
  code: string | undefined,
  fallback: AppErrorCode = 'COMMAND_FAILED',
): AppErrorCode {
  if (typeof code === 'string' && code.length > 0) return code;
  return fallback;
}

/**
 * Locator for one request's diagnostics record on the daemon host, in the
 * daemon's own vocabulary rather than as a filesystem path: `logPath` names
 * that same record as a path, which only a caller on the daemon host can read.
 * A remote caller fetches the record by this locator instead
 * (`GET /sessions/<session>/requests/<requestId>/diagnostics`).
 */
export type DiagnosticsRecordRef = {
  session: string;
  requestId: string;
};

/**
 * Details bag for AppError. Free-form context is allowed, but these keys carry
 * meaning at normalize/render time and must keep their types:
 * - `hint` — overrides `defaultHintForCode`; re-wraps preserve an existing hint.
 * - `diagnosticId` / `logPath` / `logPathUnavailable` / `diagnosticsRecord` —
 *   lifted onto the normalized error, stripped from details.
 * - `processExitError` + `stdout`/`stderr`/`exitCode` — marks a wrap of a real
 *   process exit so normalizeError can surface the first meaningful stderr line;
 *   build these via `execFailureDetails`/`requireExecSuccess` in src/utils/exec.ts
 *   rather than by hand.
 * - `retriable` — typed retry signal hoisted to the wire error shape.
 * - `reason` — machine-dispatchable sub-classification within a code.
 */
export type AppErrorDetails = Record<string, unknown> & {
  hint?: string;
  diagnosticId?: string;
  logPath?: string;
  logPathUnavailable?: string;
  diagnosticsRecord?: DiagnosticsRecordRef;
  retriable?: boolean;
  supportedOn?: string;
  processExitError?: boolean;
  stdout?: string;
  stderr?: string;
  // null mirrors the raw child_process exit event: killed by signal, no code.
  exitCode?: number | null;
  reason?: string;
};

export type NormalizedError = {
  code: string;
  message: string;
  hint?: string;
  diagnosticId?: string;
  /**
   * Diagnostics record path **the reader of this error can open**. A daemon
   * renders its own host path here; a client talking to a REMOTE daemon
   * replaces it with the caller-local copy it fetched, or drops it and sets
   * `logPathUnavailable` (see `localizeRemoteDaemonError`). A path the reader
   * cannot open never belongs in this field (#1801).
   */
  logPath?: string;
  /**
   * Why no readable `logPath` could be produced, e.g.
   * `remote daemon https://host, request 8f2c: 404`. Set only in place of
   * `logPath`, and never carries a daemon-host path.
   */
  logPathUnavailable?: string;
  /** Locator the record can be fetched by when it lives on a remote daemon. */
  diagnosticsRecord?: DiagnosticsRecordRef;
  /**
   * Lifted from `details.retriable` when a throw site classified the failure as
   * clearly transient (or clearly not). Included only when set, so the default
   * error wire shape is unchanged.
   */
  retriable?: boolean;
  supportedOn?: string;
  details?: Record<string, unknown>;
};

/**
 * Error payload returned by the daemon transport. It is kept beside the local
 * error representation because clients immediately rehydrate this wire shape
 * into `AppError` before rendering or handling it.
 */
export type DaemonError = {
  code: string;
  message: string;
  hint?: string;
  diagnosticId?: string;
  /** Path on the DAEMON host. Meaningful to a local caller only (#1801). */
  logPath?: string;
  /** Why no readable path is named; set by the client, never by the daemon. */
  logPathUnavailable?: string;
  /**
   * Additive locator (#1801) for the request diagnostics record `logPath`
   * names, so a remote caller can fetch it over the daemon API instead of
   * being handed a path on a filesystem it cannot read.
   */
  diagnosticsRecord?: DiagnosticsRecordRef;
  details?: Record<string, unknown>;
  /** Additive retry and platform-support signals; absent when not derivable. */
  retriable?: boolean;
  supportedOn?: string;
};

export class AppError extends Error {
  code: AppErrorCode;
  details?: AppErrorDetails;
  cause?: unknown;

  constructor(code: AppErrorCode, message: string, details?: AppErrorDetails, cause?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.cause = cause;
  }
}

/** Rehydrate a daemon transport error into the error type used by local callers. */
export function throwDaemonError(error: DaemonError): never {
  throw new AppError(toAppErrorCode(error.code), error.message, {
    ...(error.details ?? {}),
    hint: error.hint,
    diagnosticId: error.diagnosticId,
    logPath: error.logPath,
    logPathUnavailable: error.logPathUnavailable,
    diagnosticsRecord: error.diagnosticsRecord,
    retriable: error.retriable,
    supportedOn: error.supportedOn,
  });
}

export function asAppError(err: unknown, fallbackCode: AppErrorCode = 'UNKNOWN'): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    return new AppError(fallbackCode, err.message, undefined, err);
  }
  return new AppError(fallbackCode, 'Unknown error', { err });
}

export function isAgentDeviceError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export type NormalizeErrorContext = {
  diagnosticId?: string;
  logPath?: string;
  diagnosticsRecord?: DiagnosticsRecordRef;
};

export function normalizeAgentDeviceError(
  err: unknown,
  context: NormalizeErrorContext = {},
): NormalizedError {
  return normalizeError(err, context);
}

export function normalizeError(err: unknown, context: NormalizeErrorContext = {}): NormalizedError {
  const appErr = asAppError(err);
  const details = appErr.details ? redactDiagnosticData(appErr.details) : undefined;
  const diagnosticId = stringDetail(details, 'diagnosticId') ?? context.diagnosticId;
  const logPath = stringDetail(details, 'logPath') ?? context.logPath;
  const logPathUnavailable = stringDetail(details, 'logPathUnavailable');
  const diagnosticsRecord =
    readDiagnosticsRecordRef(details?.diagnosticsRecord) ?? context.diagnosticsRecord;
  const hint = stringDetail(details, 'hint') ?? defaultHintForCode(appErr.code);
  const retriable = booleanDetail(details, 'retriable') ?? retriableForErrorCode(appErr.code);
  const supportedOn = stringDetail(details, 'supportedOn');
  const cleanDetails = stripDiagnosticMeta(details);
  const message = maybeEnrichCommandFailedMessage(appErr.code, appErr.message, details);

  return {
    code: appErr.code,
    message,
    hint,
    diagnosticId,
    logPath,
    ...(logPathUnavailable !== undefined ? { logPathUnavailable } : {}),
    ...(diagnosticsRecord !== undefined ? { diagnosticsRecord } : {}),
    // Typed-error signals stay absent unless confidently known (#939 wire shape).
    ...(retriable !== undefined ? { retriable } : {}),
    ...(supportedOn !== undefined ? { supportedOn } : {}),
    details: cleanDetails,
  };
}

const GENERIC_EXIT_MESSAGE = /^\S+ exited with code -?\d+$/;

function maybeEnrichCommandFailedMessage(
  code: string,
  message: string,
  details: Record<string, unknown> | undefined,
): string {
  if (code !== 'COMMAND_FAILED') return message;
  if (details?.processExitError !== true) return message;
  const stderr = typeof details?.stderr === 'string' ? details.stderr : '';
  const excerpt = firstStderrLine(stderr);
  if (!excerpt) return message;
  // Generic "<tool> exited with code N" wraps carry no context of their own,
  // so the stderr excerpt replaces them outright. Curated wrap messages keep
  // the specific failure description and gain the excerpt as a suffix.
  if (GENERIC_EXIT_MESSAGE.test(message)) return excerpt;
  if (message.includes(excerpt)) return message;
  return `${message}: ${excerpt}`;
}

// Boilerplate preamble lines and tool-name/severity prefixes carry nothing the
// code/message don't already convey. These lists live in the kernel deliberately:
// normalizeError renders wire-level errors after platform code has run, so
// platforms cannot contribute patterns — revisit as a registry only if the
// lists outgrow a handful of entries.
const STDERR_SKIP_PATTERNS = [
  /^an error was encountered processing the command/i,
  /^underlying error\b/i,
  /^simulator device failed to complete the requested operation/i,
];
const STDERR_NOISE_PREFIX = /^(?:(?:adb|xcrun|simctl):\s*)?(?:error:\s*)?/i;

function firstStderrLine(stderr: string): string | null {
  for (const rawLine of stderr.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (STDERR_SKIP_PATTERNS.some((pattern) => pattern.test(line))) continue;
    const excerpt = line.replace(STDERR_NOISE_PREFIX, '').trim();
    if (!excerpt) continue;
    return excerpt.length > 200 ? `${excerpt.slice(0, 200)}...` : excerpt;
  }
  return null;
}

function stringDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Narrows an untrusted `diagnosticsRecord` — off the wire or out of a details
 * bag — to the locator type, or `undefined`. One reader, so a daemon payload
 * and a details bag can never be accepted on different terms.
 */
export function readDiagnosticsRecordRef(value: unknown): DiagnosticsRecordRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { session, requestId } = value as Partial<DiagnosticsRecordRef>;
  if (typeof session !== 'string' || typeof requestId !== 'string') return undefined;
  if (session.length === 0 || requestId.length === 0) return undefined;
  return { session, requestId };
}

function booleanDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = details?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stripDiagnosticMeta(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const output = { ...details };
  delete output.hint;
  delete output.diagnosticId;
  delete output.logPath;
  delete output.logPathUnavailable;
  delete output.diagnosticsRecord;
  delete output.retriable;
  delete output.supportedOn;
  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Conservative retriability policy for the Phase 2 typed-error graft. A code is
 * listed only when the verdict is clear (a retry can succeed without the caller
 * changing anything, or it definitely cannot); unlisted codes stay `undefined`
 * so the error wire shape is unchanged unless we have a confident answer.
 *
 * Keyed by `KnownAppErrorCode`, so a verdict cannot be given to a code the
 * registry does not enumerate — that would classify a code as retriable while
 * escaping the gate that requires a recovery quiz for it.
 */
const RETRIABILITY_BY_CODE: Partial<Record<KnownAppErrorCode, boolean>> = {
  // The device is healthy but currently leased/busy — the same request can
  // succeed once it frees up.
  DEVICE_IN_USE: true,
};

function isKnownAppErrorCode(code: string): code is KnownAppErrorCode {
  return (KNOWN_APP_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * The retriability verdict for a code, or `undefined` when there is none —
 * including for every daemon/runner-originated code outside
 * `KNOWN_APP_ERROR_CODES`, which cannot carry a verdict at all.
 */
export function retriableForErrorCode(code: string): boolean | undefined {
  return isKnownAppErrorCode(code) ? RETRIABILITY_BY_CODE[code] : undefined;
}

export function defaultHintForCode(code: string): string | undefined {
  switch (code) {
    case 'INVALID_ARGS':
      return 'Check command arguments and run --help for usage examples.';
    case 'SESSION_NOT_FOUND':
      return 'Run open first or pass an explicit device selector.';
    case 'TOOL_MISSING':
      return 'Install required platform tooling and ensure it is available in PATH.';
    case 'DEVICE_NOT_FOUND':
      return 'Verify the target device is booted/connected and selectors match.';
    case 'APP_NOT_INSTALLED':
      return 'Run apps to discover the exact installed package or bundle id, or install the app before open.';
    case 'UNSUPPORTED_OPERATION':
      return 'This command is not available for the selected platform/device.';
    case 'UNSUPPORTED_PLATFORM':
      return 'This platform is not supported for the requested operation; run devices to inspect available targets.';
    case 'AMBIGUOUS_MATCH':
      return 'Multiple candidates matched. Narrow the query or pass an exact identifier.';
    case 'DEVICE_IN_USE':
      return 'The device is busy with another agent-device request; retry once it frees up.';
    case 'REPLAY_DIVERGENCE':
      return 'Read details.divergence (screen/suggestions) for repair context, or rerun with --json for the full report.';
    case 'REPAIR_SESSION_EXPIRED':
      return 'The --save-script repair session was reaped before it was finalized; re-run replay <script> --save-script from the start.';
    case 'REPAIR_COMMIT_FAILED':
      return 'The repair transaction completed, but committing its healed script failed at teardown (no-clobber refusal or a filesystem error); inspect the target path/permissions, then re-run replay <script> --save-script to retry.';
    case 'NOT_IMPLEMENTED':
      return 'This command is part of the planned API but is not implemented yet.';
    case 'COMMAND_FAILED':
      return 'Retry with --debug and inspect diagnostics log for details.';
    case 'UNAUTHORIZED':
      return 'Refresh daemon metadata and retry the command.';
    case 'UNKNOWN':
      return 'Unexpected internal error. Retry with --debug and report the diagnostics log if it persists.';
    default:
      return 'Retry with --debug and inspect diagnostics log for details.';
  }
}
