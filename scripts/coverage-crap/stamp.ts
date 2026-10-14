// Which run wrote `coverage/`, in the words its record uses.
//
// The reports a CRAP verdict reads are produced minutes or days before the verdict, and nothing inside
// them says when. One coverage pass writes the reports and this record beside it, so that a verdict can be
// told from a stale one. What a pass knew when it reported is all this file answers.
//
// Identity is the tree the run read, not the files it scored: the hash covers every path `git` lists as
// tracked or untracked while the ignore rules allow it. A coverage pass loads setup files, helpers, and
// the config that declares the scope, and a test file decides what the map says about the source it
// covers, so an edit anywhere in that tree changes the map this checkout would produce. Restricting the
// hash to instrumented files would leave the local loop the stamp exists for unguarded: add a test to
// clear a CRAP hit, and the old map still answers for the old tests.
//
// Because a pass runs for minutes against a checkout its author may well be editing, that tree is captured
// as the pass begins and confirmed as it ends: the record describes what the tests loaded, and only
// `beginCoverageRun` and `finishCoverageRun` together know both ends. `runSelection` is recorded beside it
// because a narrowed pass still reports every included file, mostly as uncovered, and a map like that
// scores well-tested functions as if they were untested. `include`/`exclude` stay as the declaration of
// what the run was told to instrument, which is how a verdict tells a gap from a file never in scope.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';

/** Inside `reportsDirectory`, naming the run that wrote the reports beside it. */
export const COVERAGE_STAMP_FILE = 'coverage-run-stamp.json';

/** What one coverage pass was resolved to measure, in the words `test.coverage` uses. */
export type CoverageConfig = Readonly<{
  include: readonly string[];
  exclude: readonly string[];
}>;

/**
 * How far one invocation exercised the repository's tests, as the writer can observe it. `full` rests on
 * evidence rather than on nobody noticing a narrowing, and every other value names the reason the pass
 * cannot answer for a whole-tree map.
 */
export type RunSelection =
  | 'full'
  | 'project'
  | 'files'
  | 'test-name'
  | 'test-ids'
  | 'shard'
  | 'tags'
  | 'unattested';

export type CoverageStamp = Readonly<{
  schemaVersion: 1;
  /** The commit the pass began and ended against. */
  head: string;
  /** Every path the pass could have loaded, with its bytes, as of the moment it began. */
  workingTreeHash: string;
  runSelection: RunSelection;
  include: readonly string[];
  exclude: readonly string[];
}>;

/**
 * One hash over the tree a coverage run read: every path `git` lists as tracked or untracked while the
 * ignore rules allow it, path and bytes together, so adding, renaming, deleting, or editing a body in
 * place all move it. `HEAD` cannot carry this, because the loop the stamp guards is editing tests
 * against a map before committing, and a commit's tree object would not see those edits. A listed path
 * with nothing readable behind it — an unstaged deletion — is hashed as absent rather than skipped, so
 * it moves the hash and the pass writing the stamp never dies on it.
 */
function workingTreeHash(root: string): string {
  const files = runCmdSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
    },
  )
    .stdout.split('\0')
    .filter(Boolean)
    .sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(path.join(root, file)));
    } catch {
      hash.update('absent');
    }
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** The commit to stamp, or the empty string when the checkout has none. */
function checkoutHead(root: string): string {
  return runCmdSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: root,
    allowFailure: true,
  }).stdout.trim();
}

/** The checkout one coverage pass is about to read. */
export type CoverageRun = Readonly<{
  root: string;
  head: string;
  workingTreeHash: string;
}>;

/**
 * Takes the identity of the tree a coverage pass is about to read, before it collects a test. The pass
 * runs for minutes, and a stamp has to describe the tree the tests loaded rather than the one standing
 * when the provider finished writing.
 */
export function beginCoverageRun(root: string): CoverageRun {
  const head = checkoutHead(root);
  if (head === '') throw new Error('cannot stamp a coverage run in a checkout with no commit');
  return { root, head, workingTreeHash: workingTreeHash(root) };
}

/** Whether a finished pass may attest the reports it wrote, or found the checkout had moved under it. */
export type CoverageStampWrite = Readonly<{ written: CoverageStamp }> | Readonly<{ moved: true }>;

/**
 * Stamps a finished pass, having confirmed the tree is still the one `beginCoverageRun` captured. A pass
 * that read one tree and reported another describes neither, so it writes no record and names no
 * narrowing: the map is unusable whatever it says, and the writer cannot know which files it loaded.
 *
 * It deletes nothing, because a pass cannot tell the record an earlier pass left from one a concurrent
 * pass wrote while this one ran. That is safe rather than a hole: Vitest's provider removes the whole
 * reports directory at the start of every coverage pass (`createCoverageProvider` awaits
 * `provider.clean`), so a refused pass leaves reports with no stamp beside them, which verification
 * refuses as absent, and no record ever outlives the reports it described.
 */
export function finishCoverageRun(
  run: CoverageRun,
  reportsDirectory: string,
  config: CoverageConfig,
  runSelection: RunSelection,
): CoverageStampWrite {
  if (checkoutHead(run.root) !== run.head || workingTreeHash(run.root) !== run.workingTreeHash) {
    return { moved: true };
  }
  const stampPath = path.join(reportsDirectory, COVERAGE_STAMP_FILE);
  const stamp: CoverageStamp = {
    schemaVersion: 1,
    head: run.head,
    workingTreeHash: run.workingTreeHash,
    runSelection,
    include: [...config.include].sort(),
    exclude: [...config.exclude].sort(),
  };
  fs.mkdirSync(reportsDirectory, { recursive: true });
  fs.writeFileSync(stampPath, `${JSON.stringify(stamp)}\n`);
  return { written: stamp };
}
