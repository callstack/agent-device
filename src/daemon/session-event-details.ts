/** Event detail builders collect optional fields; omit absent values before writing/returning them. */
export function definedEventDetails(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
