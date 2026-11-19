import type { NormalizedError } from '@agent-device/kernel/errors';

type JsonResult = { success: true; data?: unknown } | { success: false; error: NormalizedError };

export function printJson(result: JsonResult): void {
  process.stdout.write(`${stringifyJson(result)}\n`);
}

/**
 * JSON for a terminal or a pipe: `JSON.stringify` escapes C0 but writes DEL and C1 raw, so those are escaped as
 * `\uNNNN` too. They only occur inside strings, so the output stays valid JSON and parses to the same values.
 */
export function stringifyJson(value: unknown): string {
  return [...JSON.stringify(value, null, 2)]
    .map((char) =>
      char >= '\u007f' && char <= '\u009f'
        ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
        : char,
    )
    .join('');
}
