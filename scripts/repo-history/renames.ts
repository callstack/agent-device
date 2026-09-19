// Rename resolution: every `R` record contributes `oldPath -> newPath`, and `resolve` walks the
// map transitively so a historical path reaches today's path. The map is keyed by path alone
// (no time axis), so a path that was reused after a rename follows the later rename; that is
// the model the reports declare, and the residue is a dropped record rather than a wrong one
// because consumers keep only paths that resolve to a current production file.

import type { RawCommit } from './git-log.ts';

export type PathResolver = (path: string) => string;

/** `oldPath -> newPath` from every rename record, later commits overriding earlier ones. */
export function buildRenameMap(commits: readonly RawCommit[]): Map<string, string> {
  const renames = new Map<string, string>();
  for (const commit of commits) {
    for (const record of commit.records) {
      if (record.status !== 'R' || !record.oldPath) continue;
      renames.set(record.oldPath, record.path);
    }
  }
  return renames;
}

/**
 * Applies the rename map transitively. A cycle (a path renamed back to an earlier name) stops
 * at the first revisited path; results are memoised per input path.
 */
export function createPathResolver(renames: ReadonlyMap<string, string>): PathResolver {
  const resolved = new Map<string, string>();
  return (start) => {
    const cached = resolved.get(start);
    if (cached !== undefined) return cached;
    const visited = new Set<string>([start]);
    let current = start;
    for (;;) {
      const next = renames.get(current);
      if (next === undefined || visited.has(next)) break;
      visited.add(next);
      current = next;
    }
    resolved.set(start, current);
    return current;
  };
}
