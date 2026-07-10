import { normalizeError, type NormalizedError } from '../kernel/errors.ts';

/**
 * Shared MCP error normalization + text rendering, used by both the tool
 * executor's own catch (`command-tools.ts`, so it can pin divergence screen
 * refs before returning) and the router's outer catch (`router.ts`, for
 * failures outside a resolved command — bad tool name, malformed params).
 * Keep the full error contract (code + hint) visible to MCP agents; a bare
 * message string strips exactly the guidance the hint system exists to give.
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
