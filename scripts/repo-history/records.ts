// First-touch records: for every current production file, the first commit in `git log` order
// (newest first) whose rename-resolved record adds or renames it — the commit that placed the
// file where it is today, not the birth of its oldest ancestor. The subject is the legibility
// report's fourth piece of evidence, and it is the placement commit's subject that explains the
// placement. `status: 'R'` therefore means the file arrived at its current path by rename.

import type { RawCommit } from './git-log.ts';
import type { PathResolver } from './renames.ts';

export type FirstTouch = {
  /** The current production path. */
  id: string;
  sha: string;
  date: string;
  subject: string;
  /** Status of the record that first touched the lineage. */
  status: 'A' | 'R';
  /** The path that record wrote, before any later rename. */
  path: string;
};

export function firstTouchRecords(
  commits: readonly RawCommit[],
  currentFiles: ReadonlySet<string>,
  resolve: PathResolver,
): Map<string, FirstTouch> {
  const records = new Map<string, FirstTouch>();
  for (let index = commits.length - 1; index >= 0; index--) {
    const commit = commits[index]!;
    for (const record of commit.records) {
      if (record.status !== 'A' && record.status !== 'R') continue;
      const id = resolve(record.path);
      if (!currentFiles.has(id) || records.has(id)) continue;
      records.set(id, {
        id,
        sha: commit.sha,
        date: commit.date,
        subject: commit.subject,
        status: record.status,
        path: record.path,
      });
    }
  }
  return records;
}

/** True when a rename lies between the first-touch record and the file's current path. */
export function arrivedViaRename(record: FirstTouch): boolean {
  return record.status === 'R' || record.path !== record.id;
}
