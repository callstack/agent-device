// The one rule for turning a path a tool handed us into a repo-relative posix path. Coverage maps,
// lcov reports and unified diffs each arrive with their own idea of a path — Vitest writes absolute
// keys, lcov writes paths relative to where the run started, git prefixes both sides — and they only
// join if relativization has exactly one implementation. Two that disagree silently, and a map from
// another checkout reads as "no file was measured".

import path from 'node:path';

/**
 * `raw` as seen from `root`, in posix form.
 *
 * An absolute path outside the root comes back with `../` segments rather than staying absolute: it
 * matches no file in this checkout, and it does so identically for every caller.
 */
export function repoRelativePath(raw: string, root?: string): string {
  const posix = raw.trim().split('\\').join('/');
  if (!root || !path.isAbsolute(posix)) return posix;
  return path
    .relative(root.replace(/[\\/]$/, ''), posix)
    .split(path.sep)
    .join('/');
}
