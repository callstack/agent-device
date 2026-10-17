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
  // Whether the new side is a regular git blob (mode 100644/100755), the only kind
  // whose working-tree bytes are the file's content. A symlink (120000) carries its
  // target path as content and its working-tree entry can resolve to a directory,
  // which reading as a file dies on (EISDIR); a gitlink (160000) names a nested
  // repository. Content readers must skip what this rules out.
  readonly regularFile: boolean;
};

// Git object modes the new side can carry in a diff header for something that is
// not a regular blob. `readChangedLinesDiff` reports their bodies as text lines
// (a link target, a `Subproject commit`), which no content reader may treat as
// source. Parsed rather than probed on disk: the verdict describes the commit the
// diff was cut against, not whatever the working tree holds at check time.
// `000000` is `+++ /dev/null`, the side of a deletion.
const NON_BLOB_MODES = new Set(['000000', '120000', '160000']);

type DiffSection = {
  path: string;
  added: Set<number>;
  deleted: boolean;
  cursor: number;
  /** The new side's object mode, as the headers state it; null when they stay silent. */
  newMode: string | null;
};

function newStartOfHunk(line: string): number | null {
  const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return match ? Number(match[1]) : null;
}

function pathFromDiffHeader(line: string): string {
  const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  return header ? normalizePath(header[1]!) : '';
}

// Reads the new side's object mode out of the metadata lines that carry it, last
// writer wins in header order (`old mode`, `new mode`, then the `index` trailer).
// A hand-built diff may carry neither, which leaves the mode unknown and the side
// read as regular.
function foldModeLine(section: DiffSection, line: string): boolean {
  const declared = /^(?:new file mode|old mode|new mode|deleted file mode) (\d{6})$/.exec(line);
  if (declared) {
    // `deleted file mode` describes the removed side; the new side is /dev/null.
    section.newMode = line.startsWith('deleted') ? '000000' : declared[1]!;
    return true;
  }
  if (!line.startsWith('index ')) return false;
  const trailing = / (\d{6})$/.exec(line);
  if (trailing) section.newMode = trailing[1]!;
  return true;
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
  } else if (foldModeLine(section, line)) {
    // Object-mode metadata; recorded above, carries no new-side number.
  } else {
    section.cursor += 1;
  }
}

// The object mode of a section's new side is known only once its headers have
// been read; until then it is null, which readers treat as a regular file.
function isRegularFileSide(newMode: string | null): boolean {
  return newMode === null || !NON_BLOB_MODES.has(newMode);
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
        regularFile: isRegularFileSide(section.newMode),
      });
    }
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      section = {
        path: pathFromDiffHeader(line),
        added: new Set(),
        deleted: false,
        cursor: 0,
        newMode: null,
      };
    } else if (section) {
      foldDiffBodyLine(section, line);
    }
  }
  flush();
  return files;
}
