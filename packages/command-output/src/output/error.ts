import {
  AppError,
  normalizeError,
  readErrorCandidateViews,
  type ErrorCandidateView,
  type NormalizedError,
} from '@agent-device/kernel/errors';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { formatReplayDivergenceReport } from '@agent-device/ad-replay/divergence';
import { collapseWarningText } from '../output-common.ts';

/**
 * The lines a human error prints to stderr, in order. A segment may itself span several lines
 * (candidate views, the divergence report, the details dump); the writer ends each with a newline.
 */
export function formatHumanErrorLines(
  err: AppError | NormalizedError,
  options: { showDetails?: boolean; footer?: boolean } = {},
): string[] {
  const normalized = err instanceof AppError ? normalizeError(err) : err;
  const lines = [`Error (${normalized.code}): ${normalized.message}`];
  if (normalized.cause) {
    const code = normalized.cause.code ? `${normalized.cause.code} ` : '';
    lines.push(`Cause: ${code}${normalized.cause.message}`);
  }
  if (normalized.hint) {
    lines.push(`Hint: ${normalized.hint}`);
  }
  // Composable warnings (skipped `optional` steps, capture degradations) describe the run,
  // not this step's cause, so they ride at error level and must reach the reader of a
  // failed run too — a warning-only trace is otherwise invisible outside --json (#2560).
  for (const warning of readResponseWarnings(normalized.details)) {
    lines.push(`Warning: ${collapseWarningText(warning)}`);
  }
  const candidateLines = formatErrorCandidateViews(readErrorCandidateViews(normalized.details));
  if (candidateLines.length > 0) {
    lines.push(candidateLines.join('\n'));
  }
  // The diagnostics footer names where the evidence lives, not why the run
  // failed, and a reader that keeps the tail of a merged stream keeps exactly
  // these lines — so they ride the debug tier and leave the default failure
  // block ending on the error's own facts. The JSON error payload carries every
  // field at every tier.
  if (options.footer) {
    lines.push(...formatDiagnosticsFooterLines(normalized));
  }
  // ADR 0012: the divergence compact report always renders; --debug's raw
  // details dump below remains the full-object view.
  const divergenceText = formatReplayDivergenceReport(normalized.details);
  if (divergenceText) {
    lines.push(divergenceText);
  }
  if (options.showDetails && normalized.details) {
    lines.push(JSON.stringify(normalized.details, null, 2));
  }
  return lines;
}

/**
 * The diagnostics-location lines of a human error, in order.
 */
function formatDiagnosticsFooterLines(normalized: NormalizedError): string[] {
  const lines: string[] = [];
  if (normalized.diagnosticId) {
    lines.push(`Diagnostic ID: ${normalized.diagnosticId}`);
  }
  // #1801: `logPath` is always a path on THIS machine. A record that stayed on
  // a remote daemon is reported as unavailable, with the reason, on its own
  // line — never as a path the reader cannot open.
  if (normalized.logPath) {
    lines.push(`Diagnostics Log: ${normalized.logPath}`);
  }
  if (normalized.logPathUnavailable) {
    lines.push(`Remote Diagnostics: unavailable (${normalized.logPathUnavailable})`);
  }
  return lines;
}

export function formatErrorCandidateViews(views: ErrorCandidateView[]): string[] {
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
