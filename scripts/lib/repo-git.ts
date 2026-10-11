import { runCmdSync } from '@agent-device/host-kit/command';

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
