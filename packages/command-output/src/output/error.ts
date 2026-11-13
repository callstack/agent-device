import {
  AppError,
  defaultHintForCode,
  defaultHintReadsLog,
  normalizeError,
  readDispatchDisclosure,
  readErrorCandidateViews,
  type DispatchDisclosure,
  type ErrorCandidateView,
  type NormalizedError,
} from '@agent-device/kernel/errors';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { formatReplayDivergenceReport } from '@agent-device/ad-replay/divergence';
import { collapseWarningText } from '../output-common.ts';

/**
 * A failure as the CLI prints it on stderr. `summary` is one line that carries the code, the
 * message, the typed dispatch fact and the Next step, so it stays complete when a caller keeps
 * only the first or the last line. The writer prints it first and, when any `body` line or
 * other output follows, prints it again last.
 */
export type HumanErrorView = {
  summary: string;
  body: string[];
};

export type HumanErrorOptions = {
  /** Append the raw details dump (the `--debug` tier). */
  showDetails?: boolean;
  /**
   * Who reads the text. `terminal` (the default) is a person or script at the CLI. `model` is
   * an agent reading a tool result: the typed `details.reason` joins the code and the message
   * stays one line. The diagnostics log path is left out unless the recovery step is the code's
   * default and that default tells the reader to read the log.
   */
  reader?: 'terminal' | 'model';
  /** The failing command's synopsis, such as `agent-device fill <target> <text>`. */
  synopsis?: string;
};

const SUMMARY_MESSAGE_LIMIT = 300;
const INLINE_CANDIDATE_LIMIT = 3;

const DISPATCH_SENTENCE: Record<DispatchDisclosure, string> = {
  no: 'Not dispatched.',
  unknown: 'May have reached the device.',
};

/** Resolved here, from the final disclosure, so no earlier layer's hint can contradict it. */
const OBSERVE_FIRST_STEP = 'Run snapshot to check the screen before you retry.';

export function formatHumanError(
  err: AppError | NormalizedError,
  options: HumanErrorOptions = {},
): HumanErrorView {
  const normalized = err instanceof AppError ? normalizeError(err) : err;
  const candidateViews = readErrorCandidateViews(normalized.details);
  const inlineCandidates =
    normalized.code === 'AMBIGUOUS_MATCH' ? readInlineCandidates(candidateViews) : undefined;
  const forModel = options.reader === 'model';
  const { summary, truncated } = formatSummary(
    normalized,
    inlineCandidates,
    options.synopsis,
    forModel,
  );
  return {
    summary,
    body: formatBody(normalized, {
      fullMessage: truncated && !forModel,
      candidateViews: inlineCandidates ? [] : candidateViews,
      showDetails: options.showDetails,
      logLine: !forModel || hintReadsLog(normalized),
    }),
  };
}

function formatSummary(
  normalized: NormalizedError,
  inlineCandidates: string[] | undefined,
  synopsis: string | undefined,
  withReason: boolean,
): { summary: string; truncated: boolean } {
  const dispatched = readDispatchDisclosure(normalized.details);
  const message = oneLine(normalized.message);
  const shown =
    message.length > SUMMARY_MESSAGE_LIMIT
      ? `${message.slice(0, SUMMARY_MESSAGE_LIMIT)}…`
      : message;
  const next = nextStep(normalized, dispatched, inlineCandidates, synopsis);
  const reason = withReason ? readReason(normalized) : undefined;
  const label = reason ? `${normalized.code}, ${reason}` : normalized.code;
  const summary = [
    `Error (${label}): ${withFullStop(shown)}`,
    ...(dispatched ? [DISPATCH_SENTENCE[dispatched]] : []),
    ...(next ? [`Next: ${next}`] : []),
  ].join(' ');
  return { summary, truncated: shown !== message };
}

/**
 * The Next step: the hint, sharpened by typed facts. An ambiguous match with two or three
 * candidates lists them so the step names the ref to act on; an INVALID_ARGS failure adds the
 * command's synopsis; and a failure that may have reached the device starts with the
 * observe-first step, whatever hint an earlier layer resolved.
 */
function nextStep(
  normalized: NormalizedError,
  dispatched: DispatchDisclosure | undefined,
  inlineCandidates: string[] | undefined,
  synopsis: string | undefined,
): string | undefined {
  const hint = normalized.hint ? oneLine(normalized.hint) : undefined;
  const parts = [
    ...(dispatched === 'unknown' ? [OBSERVE_FIRST_STEP] : []),
    ...(inlineCandidates
      ? [
          `Act on one ref with a command that takes refs, such as press: ${inlineCandidates.join('; ')}`,
        ]
      : hint
        ? [hint]
        : []),
    ...(synopsis && normalized.code === 'INVALID_ARGS' ? [`Usage: ${synopsis}`] : []),
  ];
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function hintReadsLog(normalized: NormalizedError): boolean {
  return (
    normalized.hint === defaultHintForCode(normalized.code) && defaultHintReadsLog(normalized.code)
  );
}

const REASON_LIMIT = 80;

/** The typed `details.reason`, when the throw site classified the failure, as one bounded line. */
function readReason(normalized: NormalizedError): string | undefined {
  const raw = normalized.details?.reason;
  if (typeof raw !== 'string') return undefined;
  const reason = oneLine(raw);
  if (reason.length === 0) return undefined;
  return reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT)}…` : reason;
}

function formatBody(
  normalized: NormalizedError,
  options: {
    fullMessage: boolean;
    candidateViews: ErrorCandidateView[];
    showDetails?: boolean;
    logLine: boolean;
  },
): string[] {
  const body: string[] = [];
  if (options.fullMessage) body.push(`Message: ${normalized.message}`);
  if (normalized.cause) {
    const code = normalized.cause.code ? `${normalized.cause.code} ` : '';
    body.push(`Cause: ${code}${normalized.cause.message}`);
  }
  // Composable warnings (skipped `optional` steps, capture degradations) describe the run,
  // not this step's cause, so they ride at error level and must reach the reader of a
  // failed run too — a warning-only trace is otherwise invisible outside --json (#2560).
  for (const warning of readResponseWarnings(normalized.details)) {
    body.push(`Warning: ${collapseWarningText(warning)}`);
  }
  const candidateLines = formatErrorCandidateViews(options.candidateViews);
  if (candidateLines.length > 0) body.push(candidateLines.join('\n'));
  const logLine = options.logLine ? formatLogLine(normalized) : undefined;
  if (logLine) body.push(logLine);
  // ADR 0012: the divergence compact report always renders; --debug's raw
  // details dump below remains the full-object view.
  const divergenceText = formatReplayDivergenceReport(normalized.details);
  if (divergenceText) body.push(divergenceText);
  if (options.showDetails && normalized.details) {
    body.push(JSON.stringify(normalized.details, null, 2));
  }
  return body;
}

/**
 * #1801: `logPath` is always a path on THIS machine. A record that stayed on a remote daemon is
 * reported as unavailable, with the reason — never as a path the reader cannot open.
 */
function formatLogLine(normalized: NormalizedError): string | undefined {
  if (normalized.logPath) return `Log: ${normalized.logPath}`;
  if (normalized.logPathUnavailable) return `Log: unavailable (${normalized.logPathUnavailable})`;
  return undefined;
}

function readInlineCandidates(views: ErrorCandidateView[]): string[] | undefined {
  const [view, ...rest] = views;
  if (!view || rest.length > 0 || view.kind !== 'element-match') return undefined;
  if (view.matches < 2 || view.matches > INLINE_CANDIDATE_LIMIT) return undefined;
  if (view.candidates.length !== view.matches) return undefined;
  const lines = view.candidates.map((candidate) =>
    oneLine(pinCandidateLine(candidate, view.refsGeneration)),
  );
  // Candidates that read the same without their ref give the reader nothing to choose by, so
  // naming them as the step would invite a guess; the hint (narrow the query) stays the step.
  const descriptions = new Set(lines.map((line) => line.replace(CANDIDATE_REF_PREFIX, '')));
  return descriptions.size === lines.length ? lines : undefined;
}

const CANDIDATE_REF_PREFIX = /^@e\d+(?:~s\d+)?\s*/;

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function withFullStop(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function formatErrorCandidateViews(views: ErrorCandidateView[]): string[] {
  return views.flatMap((view) => {
    if (view.kind === 'element-match') {
      const remaining = view.matches - view.candidates.length;
      return [
        'Candidates:',
        ...view.candidates.map(
          (candidate) => `  ${pinCandidateLine(candidate, view.refsGeneration)}`,
        ),
        ...(remaining > 0 ? [`  +${remaining} more`] : []),
      ];
    }
    return ['Devices:', ...view.devices.map((device) => `  ${device.id}  ${device.name}`)];
  });
}

function pinCandidateLine(candidate: string, generation: number | undefined): string {
  if (generation === undefined) return candidate;
  return candidate.replace(/^@(e\d+)(?=\s|$)/, `@$1~s${generation}`);
}
