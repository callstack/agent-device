import type { LayeringViolation } from './model.ts';

export function retiredPathViolations(
  files: readonly string[],
  root: string,
  rule: string,
  message: string,
): LayeringViolation[] {
  const prefix = `${root}/`;
  return files
    .filter((file) => file === root || file.startsWith(prefix))
    .map((file) => ({ rule, file, line: 1, message }));
}
