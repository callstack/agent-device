import type { NormalizedError } from '@agent-device/kernel/errors';

type JsonResult = { success: true; data?: unknown } | { success: false; error: NormalizedError };

export function printJson(result: JsonResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
