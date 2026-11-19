import type { NormalizedError } from '@agent-device/kernel/errors';
import { stringifyTerminalJson } from '@agent-device/kernel/success-text';

type JsonResult = { success: true; data?: unknown } | { success: false; error: NormalizedError };

export function printJson(result: JsonResult): void {
  // stringifyTerminalJson leaves no character the CLI text writer would escape, so this is terminal-safe as written.
  process.stdout.write(`${stringifyTerminalJson(result)}\n`);
}
