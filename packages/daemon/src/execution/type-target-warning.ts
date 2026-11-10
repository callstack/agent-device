/**
 * Returns the leading token when it reads as a snapshot ref target, else null. Snapshot refs are
 * minted only as `e<n>`, so any token that starts with `@e` and a digit (any case, any suffix,
 * including a malformed `~s` generation) is a mistargeted `fill`. Words such as `@elena` or
 * `@john99` are text.
 */
export function findMistargetedTypeRefToken(value: string | undefined): string | null {
  const first = value?.trim().split(/\s+/, 1)[0];
  return first && /^@e\d/i.test(first) ? first : null;
}
