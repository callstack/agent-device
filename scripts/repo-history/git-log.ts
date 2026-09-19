// The one place git history is read: `git log -M --name-status`, oldest commit first, parsed
// into one record per touched path. Everything downstream (rename resolution, first-touch
// records, per-commit file sets) is a pure function of this shape, so the coupling and
// legibility reports describe the same history by construction and tests run on a committed
// fixture instead of the live tree.

import { execFileSync } from 'node:child_process';

export type RecordStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

export type PathRecord = {
  status: RecordStatus;
  /** The path after the commit: the new path for a rename or copy. */
  path: string;
  /** Set for rename and copy records only. */
  oldPath?: string;
};

export type RawCommit = {
  sha: string;
  /** Committer date, ISO-8601 — when the change landed, which is what a trailing window asks. */
  date: string;
  subject: string;
  records: PathRecord[];
};

const COMMIT_SEPARATOR = String.fromCharCode(1);
const FIELD_SEPARATOR = String.fromCharCode(0);

/**
 * The exact log invocation `parseNameStatusLog` understands. Oldest commit first. The separators
 * are spelled as git `%x` escapes because an argv string may not carry a NUL byte.
 */
export const NAME_STATUS_LOG_ARGS = [
  '-c',
  'core.quotePath=false',
  'log',
  '-M',
  '--name-status',
  '--reverse',
  '--date=iso-strict',
  '--format=%x01%H%x00%cI%x00%s',
] as const;

export function readNameStatusLog(repoRoot: string): string {
  return execFileSync('git', NAME_STATUS_LOG_ARGS, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
}

function parseRecord(line: string): PathRecord | null {
  const fields = line.split('\t');
  const statusField = fields[0];
  if (!statusField || fields.length < 2) return null;
  const status = statusField[0] as RecordStatus;
  if (status === 'R' || status === 'C') {
    const [, oldPath, path] = fields;
    return oldPath && path ? { status, path, oldPath } : null;
  }
  const path = fields[1];
  return path ? { status, path } : null;
}

/** Parses the output of `NAME_STATUS_LOG_ARGS`. Merge commits carry no records and stay empty. */
export function parseNameStatusLog(text: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const chunk of text.split(COMMIT_SEPARATOR)) {
    if (chunk.trim().length === 0) continue;
    const [header = '', ...body] = chunk.split('\n');
    const [sha, date, ...subjectParts] = header.split(FIELD_SEPARATOR);
    if (!sha || !date) continue;
    const records: PathRecord[] = [];
    for (const line of body) {
      if (line.length === 0) continue;
      const record = parseRecord(line);
      if (record) records.push(record);
    }
    commits.push({ sha, date, subject: subjectParts.join(FIELD_SEPARATOR), records });
  }
  return commits;
}
