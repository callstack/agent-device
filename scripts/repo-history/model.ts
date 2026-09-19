// The rename-resolved history model both shape reports consume. Built from raw log commits and
// the set of current production files; nothing here reads git or the file system.

import { resolveCommitFiles, type HistoryCommit } from './commits.ts';
import type { RawCommit } from './git-log.ts';
import { firstTouchRecords, type FirstTouch } from './records.ts';
import { buildRenameMap, createPathResolver, type PathResolver } from './renames.ts';

export type RepoHistory = {
  /** Oldest first, one entry per raw commit (merge commits have an empty file set). */
  commits: HistoryCommit[];
  firstTouch: Map<string, FirstTouch>;
  renames: Map<string, string>;
  resolve: PathResolver;
};

export function buildRepoHistory(
  raw: readonly RawCommit[],
  currentFiles: ReadonlySet<string>,
): RepoHistory {
  const renames = buildRenameMap(raw);
  const resolve = createPathResolver(renames);
  return {
    commits: resolveCommitFiles(raw, currentFiles, resolve),
    firstTouch: firstTouchRecords(raw, currentFiles, resolve),
    renames,
    resolve,
  };
}
