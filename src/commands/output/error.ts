import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import { formatReplayDivergenceReport } from '@agent-device/contracts/divergence';

export async function printHumanError(
  err: AppError | NormalizedError,
  options: { showDetails?: boolean } = {},
): Promise<void> {
  const normalized = err instanceof AppError ? normalizeError(err) : err;
  const { formatErrorCandidateLines } = await import('../../daemon/handlers/error-candidates.ts');
  process.stderr.write(`Error (${normalized.code}): ${normalized.message}\n`);
  if (normalized.cause) {
    const code = normalized.cause.code ? `${normalized.cause.code} ` : '';
    process.stderr.write(`Cause: ${code}${normalized.cause.message}\n`);
  }
  if (normalized.hint) {
    process.stderr.write(`Hint: ${normalized.hint}\n`);
  }
  // #1597: printed unconditionally (not gated behind --debug), same as the
  // divergence report below — an agent must see the candidate refs without a
  // follow-up round trip.
  const candidateLines = formatErrorCandidateLines(normalized.details);
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
