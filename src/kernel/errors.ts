import { redactDiagnosticData } from './redaction.ts';

export type KnownAppErrorCode =
  | 'INVALID_ARGS'
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_IN_USE'
  | 'TOOL_MISSING'
  | 'APP_NOT_INSTALLED'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNSUPPORTED_OPERATION'
  | 'NOT_IMPLEMENTED'
  | 'COMMAND_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'AMBIGUOUS_MATCH'
  | 'UNKNOWN';

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

type AppErrorDetails = Record<string, unknown> & {
  hint?: string;
  diagnosticId?: string;
  logPath?: string;
  retriable?: boolean;
  supportedOn?: string;
};

export type NormalizedError = {
  code: string;
  message: string;
  hint?: string;
  diagnosticId?: string;
  logPath?: string;
  /**
   * Lifted from `details.retriable` when a throw site classified the failure as
   * clearly transient (or clearly not). Included only when set, so the default
   * error wire shape is unchanged.
   */
  retriable?: boolean;
  supportedOn?: string;
  details?: Record<string, unknown>;
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

export function normalizeAgentDeviceError(
  err: unknown,
  context: { diagnosticId?: string; logPath?: string } = {},
): NormalizedError {
  return normalizeError(err, context);
}

export function normalizeError(
  err: unknown,
  context: { diagnosticId?: string; logPath?: string } = {},
): NormalizedError {
  const appErr = asAppError(err);
  const details = appErr.details ? redactDiagnosticData(appErr.details) : undefined;
  const diagnosticId = stringDetail(details, 'diagnosticId') ?? context.diagnosticId;
  const logPath = stringDetail(details, 'logPath') ?? context.logPath;
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

function firstStderrLine(stderr: string): string | null {
  const skipPatterns = [
    /^an error was encountered processing the command/i,
    /^underlying error\b/i,
    /^simulator device failed to complete the requested operation/i,
  ];

  for (const rawLine of stderr.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (skipPatterns.some((pattern) => pattern.test(line))) continue;
    return line.length > 200 ? `${line.slice(0, 200)}...` : line;
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
  delete output.retriable;
  delete output.supportedOn;
  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Conservative retriability policy for the Phase 2 typed-error graft. Returns
 * `true` only for codes that are clearly transient (a retry can succeed without
 * the caller changing anything) and `undefined` for ambiguous/deterministic
 * codes — so the error wire shape is unchanged unless we have a confident answer.
 * Intentionally small; extend as codes gain a clear retriability verdict.
 */
export function retriableForErrorCode(code: string): boolean | undefined {
  switch (code) {
    // The device is healthy but currently leased/busy — the same request can
    // succeed once it frees up.
    case 'DEVICE_IN_USE':
      return true;
    default:
      return undefined;
  }
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
