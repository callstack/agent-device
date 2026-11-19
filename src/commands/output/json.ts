import type { NormalizedError } from '@agent-device/kernel/errors';
import { writeStdout } from '../../cli/process-exit.ts';
import { stringifyTerminalJson } from '@agent-device/kernel/success-text';

type JsonResult = { success: true; data?: unknown } | { success: false; error: NormalizedError };

export function printJson(result: JsonResult): void {
  writeStdout(`${stringifyTerminalJson(result)}\n`);
}
