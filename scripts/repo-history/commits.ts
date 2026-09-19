// Per-commit file sets over today's paths: every add, modify, rename, copy, or type-change
// record resolved through the rename map and kept only when it lands on a current production
// file. Deletions are not membership — the path no longer exists, so it cannot pair with
// anything. Commits that touch no current production file keep an empty set and are left for
// the consumer to skip, so the commit count stays honest.

import type { RawCommit, RecordStatus } from './git-log.ts';
import type { PathResolver } from './renames.ts';

export type HistoryCommit = {
  sha: string;
  date: string;
  subject: string;
  /** Sorted, de-duplicated current production paths. */
  files: readonly string[];
};

const MEMBERSHIP_STATUSES: ReadonlySet<RecordStatus> = new Set(['A', 'M', 'R', 'C', 'T']);

export function resolveCommitFiles(
  commits: readonly RawCommit[],
  currentFiles: ReadonlySet<string>,
  resolve: PathResolver,
): HistoryCommit[] {
  return commits.map((commit) => {
    const files = new Set<string>();
    for (const record of commit.records) {
      if (!MEMBERSHIP_STATUSES.has(record.status)) continue;
      const id = resolve(record.path);
      if (currentFiles.has(id)) files.add(id);
    }
    return {
      sha: commit.sha,
      date: commit.date,
      subject: commit.subject,
      files: [...files].sort(),
    };
  });
}
