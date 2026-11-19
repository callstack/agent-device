export function successText(message?: string): { message?: string } {
  return message ? { message } : {};
}

export function withSuccessText<T extends Record<string, unknown>>(
  data: T,
  message?: string,
): T & { message?: string } {
  return message ? { ...data, message } : data;
}

export function readCommandMessage(data: Record<string, unknown> | undefined): string | null {
  return typeof data?.message === 'string' && data.message.length > 0 ? data.message : null;
}

/**
 * The composable response-warnings channel (skipped `optional` steps, capture
 * degradations): readers that project a response or error record onto note
 * strings go through here — daemon append, attempt outcome, and
 * recovered-quality latch, CLI success line, CLI/MCP error text, SDK client
 * (open and screenshot result), and the
 * snapshot text renderer — so one field contract has one parser. Consumers may
 * add rendering rules on top (snapshot text and screenshot result drop empty
 * notes; screenshot result keeps absent-means-undefined). The one declared
 * exception is contracts' `readSerializedSnapshotCaptureAnnotations`, which
 * keeps a local copy of the filter: contracts facades pin their eager module
 * closure (`scripts/__tests__/eager-closure-budgets.test.ts`) and this module
 * is outside it; its test cross-checks both parses so the contract cannot
 * drift. Non-string entries are other producers' bugs.
 */
export function readResponseWarnings(data: Record<string, unknown> | undefined): string[] {
  const warnings = data?.warnings;
  return Array.isArray(warnings)
    ? warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
}

// Terminal-safe output: text the CLI writes can name values a peer or a device chose (paths, labels,
// messages), so C0, DEL and C1 characters are shown as escapes instead of reaching the terminal raw.

/** C0 except newline and tab, DEL, and C1. Newline and tab are layout; every other one is escaped. */
function isEscapedControl(char: string): boolean {
  return (char < ' ' && char !== '\n' && char !== '\t') || (char >= '\u007f' && char <= '\u009f');
}

/** Text with C0 (except newline and tab), DEL and C1 characters shown as `\xNN`. */
export function escapeTerminalText(text: string): string {
  let escaped = '';
  for (const char of text) {
    escaped += isEscapedControl(char)
      ? `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
      : char;
  }
  return escaped;
}

/**
 * `JSON.stringify(value, null, 2)` with DEL and C1 escaped as `\uNNNN`, which `JSON.stringify` leaves raw. It already
 * escapes C0, and these characters occur only inside strings, so the output is valid JSON that parses back exact and
 * holds no character `escapeTerminalText` would change.
 */
export function stringifyTerminalJson(value: unknown): string {
  let escaped = '';
  for (const char of JSON.stringify(value, null, 2) ?? 'undefined') {
    escaped +=
      char >= '\u007f' && char <= '\u009f'
        ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
        : char;
  }
  return escaped;
}
