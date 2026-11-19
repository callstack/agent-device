import type { NormalizedError } from '@agent-device/kernel/errors';
import { escapeTerminalText } from '@agent-device/kernel/redaction';

type JsonResult = { success: true; data?: unknown } | { success: false; error: NormalizedError };

export function printJson(result: JsonResult): void {
  // The same escape as the CLI writer: its `\u00NN` form is a JSON escape, so the output still parses exact.
  process.stdout.write(escapeTerminalText(`${JSON.stringify(result, null, 2)}\n`));
}
