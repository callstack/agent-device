import {
  normalizeError,
  readErrorCandidateViews,
  type NormalizedError,
} from '@agent-device/kernel/errors';
import { formatReplayDivergenceReport } from '@agent-device/ad-replay/divergence';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { formatErrorCandidateViews } from '../commands/output/error.ts';
import { collapseWarningText } from '../commands/output-common.ts';

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
  for (const warning of readResponseWarnings(normalized.details)) {
    lines.push(`Warning: ${collapseWarningText(warning)}`);
  }
  lines.push(...formatErrorCandidateViews(readErrorCandidateViews(normalized.details)));
  if (normalized.supportedOn) lines.push(`Supported on: ${normalized.supportedOn}`);
  const divergence = formatReplayDivergenceReport(normalized.details);
  if (divergence) lines.push(divergence);
  return lines.join('\n');
}
