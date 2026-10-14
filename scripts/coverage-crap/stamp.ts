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
import { parseSync } from 'oxc-parser';
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

// A leading-dot path segment, marked so a glob wildcard can match it: the provider matches these
// patterns with picomatch `{ dot: true }`, while `path.matchesGlob` will not let `*` reach a
// dot-prefixed segment. The marker is not a character a path or a pattern can carry, and it adds no
// separator. It belongs to pattern matching alone — the working-tree hash lists paths, it does not
// match them.
const HIDDEN_SEGMENT = '\u0000';

function withHiddenVisible(text: string): string {
  return text
    .split('/')
    .map((segment) => (segment.startsWith('.') ? `${HIDDEN_SEGMENT}${segment}` : segment))
    .join('/');
}

/**
 * Whether the resolved config instruments `relativePath`. Vitest matches these patterns against the
 * path relative to the root, so `src/**` never reaches `packages/x/src/**`.
 */
export function isInstrumentedPath(relativePath: string, config: CoverageConfig): boolean {
  const candidate = withHiddenVisible(relativePath.split('\\').join('/'));
  return (
    config.include.some((pattern) => path.matchesGlob(candidate, withHiddenVisible(pattern))) &&
    !config.exclude.some((pattern) => path.matchesGlob(candidate, withHiddenVisible(pattern)))
  );
}

// A whole-file ignore comment drops a source from every Istanbul map, so its missing record is not a gap
// and no verdict may send the reader to re-run for it. The keyword set and its position are the
// provider's own: ast-v8-to-istanbul reads `istanbul`, `c8`, `v8`, and `node:coverage` as one keyword,
// anchored to the start of a comment after stripping the comment's own delimiters. The `start`/`stop` and
// `next` forms discard a region's counters and leave the file recorded, so the functions inside come back
// as estimates, which the verdict lists rather than blocks on.
const IGNORE_FILE_HINT = /^\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+file(?=\W|$)/;

/**
 * Whether a source declares itself outside coverage, read from the parser's comment tokens rather than
 * from the text: a pragma-shaped string literal is not a pragma, and treating one as one would exempt the
 * file from the very check that names an unmeasured file. `oxc-parser` is what the repository's own
 * source policies already use, and its comment tokens survive a parse error.
 *
 * A token's `value` still carries the `*` a `/**` opener introduced, which the provider has already
 * stripped by the time it matches, so one leading `*` comes off here too — without that, the JSDoc
 * spelling would exempt a file from the provider's counts while this read still demanded a record for it.
 *
 * Only worth calling for a path `isInstrumentedPath` accepted: a file the config excludes cannot appear
 * in the map whatever its comments say, and this parses JavaScript, so asking it about a document or a
 * binary would spend a parse to learn nothing.
 */
export function declaresWholeFileIgnore(filePath: string, source: string): boolean {
  return parseSync(filePath, source).comments.some((comment) =>
    IGNORE_FILE_HINT.test(comment.value.replace(/^\*/, '')),
  );
}

/** A selection that cannot attest a whole-tree map; only `full` can, so it is excluded by name. */
export type NarrowedRunSelection = Exclude<RunSelection, 'full'>;

/** Why `coverage/` cannot answer for this checkout. The report and the fix both branch on `kind`. */
export type StampMismatch =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unreadable'; detail: string }>
  | Readonly<{ kind: 'scope' }>
  | Readonly<{ kind: 'head'; stampHead: string; head: string }>
  | Readonly<{ kind: 'selection'; runSelection: NarrowedRunSelection }>
  | Readonly<{ kind: 'workingTree'; stampHash: string; workingTreeHash: string }>;

const MISMATCH_WHY: Readonly<Record<StampMismatch['kind'], string>> = {
  absent: `coverage/ carries no ${COVERAGE_STAMP_FILE}, so nothing here says which run wrote it`,
  unreadable: 'the coverage run stamp is not a stamp this check can read',
  scope: 'the coverage run declared no include patterns, so its record cannot say what it measured',
  head: 'HEAD moved since the coverage run wrote its stamp',
  selection:
    'the coverage run that wrote these reports did not exercise the whole coverage lane, so files it ' +
    'never ran a test for read as untested',
  workingTree: 'this checkout changed since the coverage run wrote its stamp',
};

const NARROWED_BY: Readonly<Record<NarrowedRunSelection, string>> = {
  project:
    'a project filter left projects out, or the run used a config this check cannot recognize',
  files: 'a file filter ran only some test files',
  'test-name': 'a test-name pattern ran only matching tests',
  'test-ids': 'it ran selected tests or lines',
  shard: 'a shard ran part of the suite',
  tags: 'a tag filter ran only tests carrying those tags',
  unattested:
    'it ran with focused tests allowed, so one `test.only` anywhere in the tree would have run in place ' +
    'of the lane and still collected every test file — `test:coverage` passes `--allowOnly=false`',
};

export function describeStampMismatch(mismatch: StampMismatch): string {
  const detail =
    mismatch.kind === 'unreadable'
      ? `: ${mismatch.detail}`
      : mismatch.kind === 'head'
        ? ` (stamped ${mismatch.stampHead}, now ${mismatch.head})`
        : mismatch.kind === 'selection'
          ? `: ${NARROWED_BY[mismatch.runSelection]}`
          : mismatch.kind === 'workingTree'
            ? ` (stamped ${mismatch.stampHash}, now ${mismatch.workingTreeHash})`
            : '';
  // A run that declared no scope stays undeclared however often it is re-run, so that one names the
  // declaration to fix. Every other kind is drift or a narrowed run, and a fresh pass over this commit
  // restates it.
  const fix =
    mismatch.kind === 'scope'
      ? 'Give `test.coverage.include` a pattern list, then run `pnpm test:coverage`.'
      : 'Run `pnpm test:coverage` on this commit.';
  return `${MISMATCH_WHY[mismatch.kind]}${detail}\n  ${fix}`;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRunSelection(value: unknown): value is RunSelection {
  // The union is the whole vocabulary, and `NARROWED_BY` has to cover every member but `full` to compile, so
  // these two already are the writer's list: adding a selection without a sentence is a type error, and a
  // record carrying anything else is unreadable rather than a pass. The type test comes first because the
  // value is whatever JSON said — an object with a null `toString` throws on the way to that verdict, which
  // is the one outcome `unreadable` exists to cover.
  return typeof value === 'string' && (value === 'full' || Object.hasOwn(NARROWED_BY, value));
}

function readStampFile(stampPath: string): CoverageStamp | StampMismatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch (error: unknown) {
    return {
      kind: 'unreadable',
      detail: error instanceof Error ? error.message.split('\n')[0]! : String(error),
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unreadable', detail: 'not an object' };
  }
  // Field order: each row has to name the field actually wrong, so validation stops at the first field
  // it cannot read rather than at whichever branch happens to come first.
  const stamp = parsed as Partial<CoverageStamp>;
  if (stamp.schemaVersion !== 1) {
    // `JSON.stringify` rather than `String`: a record whose `schemaVersion` is an object carrying its own
    // null `toString` throws at the conversion, and this function's contract is to answer `unreadable`
    // rather than to throw. JSON can only have produced what stringify can already serialize.
    return {
      kind: 'unreadable',
      detail: `schemaVersion ${JSON.stringify(stamp.schemaVersion)} is not 1`,
    };
  }
  if (typeof stamp.head !== 'string' || stamp.head === '') {
    return { kind: 'unreadable', detail: 'head is not a commit' };
  }
  if (typeof stamp.workingTreeHash !== 'string' || stamp.workingTreeHash === '') {
    return { kind: 'unreadable', detail: 'workingTreeHash is not a hash' };
  }
  if (!isRunSelection(stamp.runSelection)) {
    return { kind: 'unreadable', detail: 'runSelection is not a run selection' };
  }
  if (!isStringArray(stamp.include)) {
    return { kind: 'unreadable', detail: 'include is not a list of patterns' };
  }
  if (!isStringArray(stamp.exclude)) {
    return { kind: 'unreadable', detail: 'exclude is not a list of patterns' };
  }
  // Vitest reads a missing `include` as "whatever the excludes leave", so an empty list is not a scope
  // the verdict can decide eligibility from: the record cannot say what the run measured, and re-running
  // would declare no more than this one did. Both lists are read as part of that scope, so a malformed one
  // is named before this, which would otherwise send the reader to fix the wrong field.
  if (stamp.include.length === 0) return { kind: 'scope' };
  return {
    schemaVersion: 1,
    head: stamp.head,
    workingTreeHash: stamp.workingTreeHash,
    runSelection: stamp.runSelection,
    include: stamp.include,
    exclude: stamp.exclude,
  };
}

/**
 * The stamp in `reportsDirectory` against this checkout: same commit, a pass that proved it took the whole
 * coverage lane, and that same tree still on disk. `reportsDirectory` comes from the reports' own home, so
 * a run pointed elsewhere is simply absent here rather than quietly trusted.
 */
export function verifyCoverageStamp(
  reportsDirectory: string,
  root: string,
): Readonly<{ stamp: CoverageStamp }> | Readonly<{ mismatch: StampMismatch }> {
  const stampPath = path.join(reportsDirectory, COVERAGE_STAMP_FILE);
  if (!fs.existsSync(stampPath)) return { mismatch: { kind: 'absent' } };
  const stamp = readStampFile(stampPath);
  if ('kind' in stamp) return { mismatch: stamp };
  const head = checkoutHead(root);
  if (head !== stamp.head) {
    return { mismatch: { kind: 'head', stampHead: stamp.head, head } };
  }
  // Before the tree hash: a narrowed map is unusable whatever the tree looks like, and this spares
  // hashing a whole checkout to explain a reason already on disk.
  if (stamp.runSelection !== 'full') {
    return { mismatch: { kind: 'selection', runSelection: stamp.runSelection } };
  }
  const workingTreeHashNow = workingTreeHash(root);
  if (workingTreeHashNow !== stamp.workingTreeHash) {
    return {
      mismatch: {
        kind: 'workingTree',
        stampHash: stamp.workingTreeHash,
        workingTreeHash: workingTreeHashNow,
      },
    };
  }
  return { stamp };
}
