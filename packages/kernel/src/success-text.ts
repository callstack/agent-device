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
