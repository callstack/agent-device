import {
  AppError,
  normalizeError,
  readErrorCandidateViews,
  type ErrorCandidateView,
  type NormalizedError,
} from '@agent-device/kernel/errors';
import { formatReplayDivergenceReport } from '@agent-device/contracts/divergence';

export function printHumanError(
  err: AppError | NormalizedError,
  options: { showDetails?: boolean } = {},
): void {
  const normalized = err instanceof AppError ? normalizeError(err) : err;
  process.stderr.write(`Error (${normalized.code}): ${normalized.message}\n`);
  if (normalized.cause) {
    const code = normalized.cause.code ? `${normalized.cause.code} ` : '';
    process.stderr.write(`Cause: ${code}${normalized.cause.message}\n`);
  }
  if (normalized.hint) {
    process.stderr.write(`Hint: ${normalized.hint}\n`);
  }
  const candidateLines = formatErrorCandidateViews(readErrorCandidateViews(normalized.details));
  if (candidateLines.length > 0) {
    process.stderr.write(`${candidateLines.join('\n')}\n`);
  }
  if (normalized.diagnosticId) {
    process.stderr.write(`Diagnostic ID: ${normalized.diagnosticId}\n`);
  }
  // #1801: `logPath` is always a path on THIS machine. A record that stayed on
  // a remote daemon is reported as unavailable, with the reason, on its own
  // line — never as a path the reader cannot open.
  if (normalized.logPath) {
    process.stderr.write(`Diagnostics Log: ${normalized.logPath}\n`);
  }
  if (normalized.logPathUnavailable) {
    process.stderr.write(`Remote Diagnostics: unavailable (${normalized.logPathUnavailable})\n`);
  }
  // ADR 0012: the divergence compact report always renders; --debug's raw
  // details dump below remains the full-object view.
  const divergenceText = formatReplayDivergenceReport(normalized.details);
  if (divergenceText) {
    process.stderr.write(`${divergenceText}\n`);
  }
  if (options.showDetails && normalized.details) {
    process.stderr.write(`${JSON.stringify(normalized.details, null, 2)}\n`);
  }
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
