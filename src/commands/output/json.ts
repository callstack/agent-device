import type { NormalizedError } from '@agent-device/kernel/errors';
import { escapeTerminalText, redactSecretLikeText } from '@agent-device/kernel/redaction';

type JsonResult = { success: true; data?: unknown } | { success: false; error: NormalizedError };

export function printJson(result: JsonResult): void {
  // The same escape as the CLI writer: its `\u00NN` form is a JSON escape, so the output still parses exact.
  process.stdout.write(escapeTerminalText(`${JSON.stringify(redactJsonError(result), null, 2)}\n`));
}

/**
 * An INVALID_ARGS message embeds the raw argv the parse refused, so the JSON view scrubs
 * secret-like tokens from the message the way the human summary does. The hint stays as the
 * producer wrote it: it can carry a machine-parsable example the reader is meant to run.
 * `details` is not scrubbed here: `normalizeError` already ran the structured redaction over it.
 */
function redactJsonError(result: JsonResult): JsonResult {
  if (result.success || result.error.code !== 'INVALID_ARGS') return result;
  return {
    success: false,
    error: {
      ...result.error,
      message: redactSecretLikeText(result.error.message),
    },
  };
}
