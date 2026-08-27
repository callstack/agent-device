export function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeysDeep(record[key])]),
  );
}

/**
 * Linear-time edge trim. The regex form (`/^-+|-+$/g`) backtracks polynomially
 * on long dash runs (CodeQL js/polynomial-redos), and callers build their
 * inputs from caller-supplied strings such as file paths and cache names.
 */
export function trimEdgeDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}
