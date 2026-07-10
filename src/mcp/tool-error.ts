import { normalizeError, type NormalizedError } from '../kernel/errors.ts';

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
  return lines.join('\n');
}
