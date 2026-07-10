import { normalizeError, type NormalizedError } from '../kernel/errors.ts';
import { formatReplayDivergenceReport } from '../replay/divergence.ts';

/**
 * Shared MCP error normalization + text rendering (executor and router
 * catches). Keeps the full error contract (code + hint) visible to agents.
 */
export function normalizeToolError(error: unknown): NormalizedError {
  return normalizeError(error);
}

export function formatToolErrorText(normalized: NormalizedError): string {
  const lines = [`Error (${normalized.code}): ${normalized.message}`];
  if (normalized.hint) lines.push(`Hint: ${normalized.hint}`);
  if (normalized.supportedOn) lines.push(`Supported on: ${normalized.supportedOn}`);
  // ADR 0012: the MCP text path must carry the same repair data as
  // structuredContent — a text-only divergence loses the screen refs and
  // suggestions the agent repairs from.
  const divergence = formatReplayDivergenceReport(normalized.details);
  if (divergence) lines.push(divergence);
  return lines.join('\n');
}
