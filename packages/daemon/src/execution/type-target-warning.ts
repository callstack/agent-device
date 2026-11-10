import { splitRefGenerationSuffix } from '@agent-device/kernel/snapshot';

/** Returns the leading token when it is a snapshot ref (`@e12`, `@e12~s3`), else null. */
export function findMistargetedTypeRefToken(value: string | undefined): string | null {
  const first = value?.trim().split(/\s+/, 1)[0];
  if (!first?.startsWith('@')) return null;
  const split = splitRefGenerationSuffix(first);
  return split && /^@e\d+$/.test(split.base) ? first : null;
}
