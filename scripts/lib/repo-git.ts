import { runCmdSync } from '@agent-device/host-kit/command';
import { normalizePath } from './repo-path.ts';

export type RepoGit = (args: string[]) => string;

export function repoGit(repoRoot: string): RepoGit {
  return (args) => runCmdSync('git', args, { cwd: repoRoot, allowFailure: true }).stdout.trim();
}

/** History-derivation checks cannot run against a shallow CI clone. */
export function requireUnshallowHistory(git: RepoGit, subject: string): void {
  if (git(['rev-parse', '--is-shallow-repository']) !== 'true') return;
  throw new Error(
    `${subject} needs full history and tags. Run \`git fetch --unshallow --tags\` first.`,
  );
}

const CHANGED_LINES_RENAME_SIMILARITY = '90%';
const CHANGED_LINES_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * The zero-context diff of HEAD against its merge base with `base`, which the changed-line gates
 * score. Renames are paired at 90% regardless of the host's `diff.renames`, so a moved file owes
 * only the hunks that differ from its source; paths stay unquoted (`core.quotePath=false`) so a
 * non-ASCII file name matches its coverage record; the buffer fits a large stacked diff.
 */
export function readChangedLinesDiff(repoRoot: string, base: string): string {
  return runCmdSync(
    'git',
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--unified=0',
      '--no-color',
      `--find-renames=${CHANGED_LINES_RENAME_SIMILARITY}`,
      `${base}...HEAD`,
    ],
    { cwd: repoRoot, maxBuffer: CHANGED_LINES_MAX_BUFFER_BYTES },
  ).stdout;
}

export type ChangedFileDiff = {
  readonly path: string;
  // New-side line numbers of '+' lines, ascending and de-duplicated.
  readonly added: readonly number[];
  // `+++ /dev/null`: the file was deleted, so it contributes no changed lines.
  readonly deleted: boolean;
};

type DiffSection = { path: string; added: Set<number>; deleted: boolean; cursor: number };

function newStartOfHunk(line: string): number | null {
  const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return match ? Number(match[1]) : null;
}

function pathFromDiffHeader(line: string): string {
  const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  return header ? normalizePath(header[1]!) : '';
}

// Fold one line of a file's diff body into its section. Renames+edits report
// their added lines under the destination (`+++ b/...`); pure renames and
// deletions add nothing. `--unified=0` means no context lines in practice.
function foldDiffBodyLine(section: DiffSection, line: string): void {
  if (line.startsWith('+++ ')) {
    const target = line.slice(4).trim();
    if (target === '/dev/null') section.deleted = true;
    else section.path = normalizePath(target);
  } else if (line.startsWith('@@')) {
    const start = newStartOfHunk(line);
    if (start !== null) section.cursor = start;
  } else if (line.startsWith('+') && !line.startsWith('+++')) {
    section.added.add(section.cursor);
    section.cursor += 1;
  } else if (line.startsWith('-') || line.startsWith('\\')) {
    // Removed line or "\ No newline": occupies no new-side number.
  } else {
    section.cursor += 1;
  }
}

/**
 * `readChangedLinesDiff`'s report as per-file added-line sets — the one reading both changed-line
 * gates score from. Keep it beside its producer: a hand-built diff must parse the same way the
 * real one does.
 */
export function parseUnifiedDiff(diff: string): ChangedFileDiff[] {
  const files: ChangedFileDiff[] = [];
  let section: DiffSection | null = null;
  const flush = (): void => {
    if (section && section.path) {
      files.push({
        path: section.path,
        added: [...section.added].sort((a, b) => a - b),
        deleted: section.deleted,
      });
    }
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      section = { path: pathFromDiffHeader(line), added: new Set(), deleted: false, cursor: 0 };
    } else if (section) {
      foldDiffBodyLine(section, line);
    }
  }
  flush();
  return files;
}
