import {
  normalizeError,
  readErrorCandidateViews,
  type ErrorCandidateView,
  type NormalizedError,
} from '@agent-device/kernel/errors';
import { formatReplayDivergenceReport } from '@agent-device/contracts/divergence';

export function normalizeToolError(error: unknown): NormalizedError {
  return normalizeError(error);
}

export function formatToolErrorText(normalized: NormalizedError): string {
  const lines = [`Error (${normalized.code}): ${normalized.message}`];
  if (normalized.cause) {
    const code = normalized.cause.code ? `${normalized.cause.code} ` : '';
    lines.push(`Cause: ${code}${normalized.cause.message}`);
  }
  if (normalized.hint) lines.push(`Hint: ${normalized.hint}`);
  lines.push(...formatErrorCandidateViews(readErrorCandidateViews(normalized.details)));
  if (normalized.supportedOn) lines.push(`Supported on: ${normalized.supportedOn}`);
  const divergence = formatReplayDivergenceReport(normalized.details);
  if (divergence) lines.push(divergence);
  return lines.join('\n');
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
