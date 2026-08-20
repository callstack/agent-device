const VARIABLE_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_.]*\}$/;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Coerce a literal numeric-or-string field to a number, preserving unresolved ${VAR} tokens. */
export function numLike(value: unknown): number | string | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (VARIABLE_PATTERN.test(value)) return value;
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  }
  return undefined;
}

export function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
