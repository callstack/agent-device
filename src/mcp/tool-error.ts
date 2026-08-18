import { normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import { formatReplayDivergenceReport } from '@agent-device/contracts/divergence';
import { formatErrorCandidateLines } from '../utils/error-candidates.ts';

/**
 * Shared MCP error normalization + text rendering (executor and router
 * catches). Keeps the full error contract (code + hint) visible to agents.
 */
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
  // #1597: printed unconditionally, same as the CLI text path
  // (src/utils/output.ts printHumanError) — an MCP-connected agent must see
  // the candidate refs directly in the tool result text.
  lines.push(...formatErrorCandidateLines(normalized.details));
  if (normalized.supportedOn) lines.push(`Supported on: ${normalized.supportedOn}`);
  // ADR 0012: the MCP text path must carry the same repair data as
  // structuredContent — a text-only divergence loses the screen refs and
  // suggestions the agent repairs from.
  const divergence = formatReplayDivergenceReport(normalized.details);
  if (divergence) lines.push(divergence);
  return lines.join('\n');
}
