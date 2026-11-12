import { normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import { formatHumanError } from '@agent-device/command-output';

export function normalizeToolError(error: unknown): NormalizedError {
  return normalizeError(error);
}

export function formatToolErrorText(normalized: NormalizedError): string {
  const { summary, body } = formatHumanError(normalized);
  const lines = [summary, ...body];
  if (normalized.supportedOn) lines.push(`Supported on: ${normalized.supportedOn}`);
  return lines.join('\n');
}
