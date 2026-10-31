// A committed git tree as the closure walker's source of truth: the merge-base with origin/main,
// read without checking it out, so a ratchet compares against what actually landed.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { SourceTreeReader } from '@agent-device/test-kit';
import { isProductionSourceFile } from '../layering/tracked-sources.ts';

const WALKED_SOURCE = /^(?:src|packages\/[^/]+\/src)\/.*\.ts$/;
const WALKED_MANIFEST = /^packages\/[^/]+\/package\.json$/;
const WALKED_JSON_MODULE = /^(?:src|packages\/[^/]+\/src)\/.*\.json$/;

function git(repoRoot: string, args: readonly string[], input = ''): Buffer {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** The commit a branch's closures ratchet against: `git merge-base origin/main HEAD`. */
export function mergeBaseWithMain(repoRoot: string): string {
  try {
    return git(repoRoot, ['merge-base', 'origin/main', 'HEAD']).toString('utf8').trim();
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8').trim() ?? '';
    throw new Error(
      'The eager-closure ratchet needs origin/main to find its merge-base (git merge-base ' +
        `origin/main HEAD failed: ${stderr}). Fetch origin/main; the gate does not skip.`,
      { cause: error },
    );
  }
}

/**
 * The commit under measurement. Compared against `mergeBaseWithMain`, this answers whether the
 * head carries work of its own: they are equal exactly when `main` already carries this commit --
 * a push to `main`, or a branch that has not committed anything yet -- and then no entry is
 * first-introduced, whatever the tree contains.
 */
export function headCommit(repoRoot: string): string {
  return git(repoRoot, ['rev-parse', 'HEAD']).toString('utf8').trim();
}

type NameStatusRecord = Readonly<{ renamed: boolean; from: string; to: string }>;

/** Parses `--name-status -z` output; a path that was not renamed has the same `from` and `to`. */
function nameStatusRecords(output: Buffer): NameStatusRecord[] {
  const fields = output.toString('utf8').split('\0');
  const records: NameStatusRecord[] = [];
  for (let index = 0; index < fields.length;) {
    const kind = fields[index++]?.trim();
    if (!kind) continue;
    const renamed = kind.startsWith('R');
    const from = fields[index++];
    const to = renamed ? fields[index++] : from;
    if (from && to) records.push({ renamed, from, to });
  }
  return records;
}

function endOriginsChangedOnBase(
  repoRoot: string,
  historyBase: string,
  baseCommit: string,
  origins: Map<string, string | null>,
  ended: Set<string>,
): void {
  const changed = nameStatusRecords(
    git(repoRoot, [
      '-c',
      'diff.renameLimit=0',
      'log',
      '--first-parent',
      '--format=',
      '--name-status',
      '-M',
      '-z',
      `${historyBase}..${baseCommit}`,
    ]),
  );
  const changedPaths = new Set(changed.flatMap(({ from, to }) => [from, to]));
  for (const [file, origin] of origins) {
    if (origin !== null && changedPaths.has(origin)) {
      origins.set(file, null);
      ended.add(file);
    }
  }
}

/**
 * Head path -> base path. Follow committed moves before the aggregate diff, so later edits do not
 * erase a recorded rename. Added or deleted paths end that lineage. The aggregate diff still finds
 * a move spread across commits or staged in the working tree. For a merge into the measured base,
 * follow its second parent's history, invalidate origins changed on the first parent, and apply the
 * second-parent-to-merge diff to tracked lineage only. Unlimited detection handles bulk moves.
 */
export function renamedSince(
  repoRoot: string,
  base: string,
  head?: string,
): ReadonlyMap<string, string> {
  const origins = new Map<string, string | null>();
  const ended = new Set<string>();
  const flags = ['--name-status', '-M', '--diff-filter=ADR', '-z'];
  const follow = (status: Buffer, trackedOnly = false): void => {
    for (const { renamed, from, to } of nameStatusRecords(status)) {
      if (trackedOnly && !origins.has(from)) continue;
      const origin = renamed && origins.has(from) ? origins.get(from)! : from;
      if (!renamed && typeof origins.get(from) === 'string') ended.add(from);
      origins.set(from, null);
      if (!renamed) continue;
      origins.set(to, origin);
      if (origin === null) ended.add(to);
      else ended.delete(to);
    }
  };
  const measured = head ?? 'HEAD';
  const parents = git(repoRoot, ['rev-list', '--parents', '-n', '1', measured])
    .toString('utf8')
    .trim()
    .split(' ');
  const baseCommit = git(repoRoot, ['rev-parse', `${base}^{commit}`])
    .toString('utf8')
    .trim();
  const isMergeIntoBase = parents.length === 3 && parents[1] === baseCommit;
  const historyHead = isMergeIntoBase ? parents[2]! : measured;
  const historyBase = isMergeIntoBase
    ? git(repoRoot, ['merge-base', baseCommit, historyHead]).toString('utf8').trim()
    : base;
  follow(
    git(repoRoot, [
      '-c',
      'diff.renameLimit=0',
      'log',
      '--reverse',
      '--first-parent',
      '--format=',
      ...flags,
      `${historyBase}..${historyHead}`,
    ]),
  );
  if (isMergeIntoBase) {
    endOriginsChangedOnBase(repoRoot, historyBase, baseCommit, origins, ended);
    follow(
      git(repoRoot, ['-c', 'diff.renameLimit=0', 'diff', ...flags, historyHead, measured]),
      true,
    );
  }
  if (!head) follow(git(repoRoot, ['-c', 'diff.renameLimit=0', 'diff', ...flags, 'HEAD']));
  const renamed = new Map<string, string>();
  for (const [file, origin] of origins) {
    if (origin !== null) renamed.set(file, origin);
  }
  const claimedOrigins = new Set(renamed.values());
  const aggregate = git(repoRoot, [
    '-c',
    'diff.renameLimit=0',
    'diff',
    ...flags,
    base,
    ...(head ? [head] : []),
  ]);
  for (const { renamed: isRename, from, to } of nameStatusRecords(aggregate)) {
    if (isRename && !renamed.has(to) && !ended.has(to) && !claimedOrigins.has(from)) {
      renamed.set(to, from);
      claimedOrigins.add(from);
    }
  }
  return renamed;
}

/**
 * Production source paths tracked at `base` but gone from the working tree. The diff requests
 * rename pairing explicitly (`--find-renames`, so a `diff.renames=false` gitconfig cannot
 * weaken it), and --diff-filter=D drops the paired ones, so this lists only the deletions that
 * pairing did NOT absorb -- a moved-and-rewritten module the detector could not pair, which
 * `renamedSince`
 * answers by detection and therefore misses. The split tolerance reads these paths' content
 * through `movedFromDeletedSource`: two or more statements shared with ONE deleted source is a
 * move signal, so a verbatim transplant stays non-novel; one shared statement is tolerated as
 * coincidence, and a statement-by-statement rewrite evades a textual match. This probe is the
 * reinforcement -- containment is what structurally refuses a dropped-and-swapped base module
 * (#3298 review). And the pairing itself is load-bearing: it keeps a split's re-homed hub OUT
 * of this list (paired to its closest part), while disabling it (--no-renames, or the gitconfig
 * the explicit flag overrides) would put the hub here, making the split's own parts share two
 * statements with "deleted source" and refusing the very extraction the tolerance exists for.
 */
export function deletedSourcesSince(repoRoot: string, base: string): string[] {
  const status = git(repoRoot, [
    'diff',
    '--name-only',
    '--find-renames',
    '--diff-filter=D',
    '-z',
    base,
  ]);
  return status
    .toString('utf8')
    .split('\0')
    .filter((file) => file !== '' && WALKED_SOURCE.test(file) && isProductionSourceFile(file));
}

/** A carried entry must have been a source the base closure walker could actually read. */
export function baseProductionPathOf(
  repoRoot: string,
  entryFile: string,
  baseTree: SourceTreeReader,
  renamedFrom: ReadonlyMap<string, string>,
): string | null {
  const baseFile = renamedFrom.get(entryFile) ?? entryFile;
  return WALKED_SOURCE.test(baseFile) &&
    isProductionSourceFile(baseFile) &&
    baseTree.isFile(path.resolve(repoRoot, baseFile))
    ? baseFile
    : null;
}

/** Every path tracked at `treeish`, repo-root-relative, from ONE `git ls-tree`. */
function listCommittedTree(repoRoot: string, treeish: string): string[] {
  const listing = git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', treeish]).toString('utf8');
  return listing.split('\0').filter(Boolean);
}

/**
 * The sources this reader serves, split by kind: production TypeScript under `src/` and
 * `packages/<pkg>/src/`, JSON modules a source there can import, and workspace package
 * manifests. One definition, so a consumer reading a committed tree cannot classify it
 * differently from the walker.
 */
function committedSourceSet(tracked: readonly string[]): {
  sources: string[];
  jsonModules: string[];
  manifests: string[];
} {
  return {
    sources: tracked.filter((file) => WALKED_SOURCE.test(file) && isProductionSourceFile(file)),
    jsonModules: tracked.filter((file) => WALKED_JSON_MODULE.test(file)),
    manifests: tracked.filter((file) => WALKED_MANIFEST.test(file)),
  };
}

/** Contents of `files` at `treeish`, through ONE long-lived `git cat-file --batch`. */
function readCommittedBlobs(
  repoRoot: string,
  treeish: string,
  files: readonly string[],
): Map<string, string> {
  if (files.length === 0) return new Map();
  const requests = files.map((file) => `${treeish}:${file}\n`).join('');
  return parseCatFileBatch(git(repoRoot, ['cat-file', '--batch'], requests), files);
}

/**
 * The same enumeration and blob read as `createCommittedSourceTree`, handed over as text: the
 * production sources and workspace manifests committed at `treeish`, plus every committed path. A whole-tree measurement
 * (the layering ratchets) needs the corpus rather than a reader, and taking it from here is what
 * keeps its file set identical to the closure walker's.
 */
// fallow-ignore-next-line unused-export -- consumed by scripts/layering, outside fallow's scope
export function readCommittedSources(
  repoRoot: string,
  treeish: string,
): { sources: Map<string, string>; manifests: Map<string, string>; files: string[] } {
  const files = listCommittedTree(repoRoot, treeish);
  const { sources, manifests } = committedSourceSet(files);
  const blobs = readCommittedBlobs(repoRoot, treeish, [...sources, ...manifests]);
  const only = (files: readonly string[]) =>
    new Map(files.flatMap((file) => (blobs.has(file) ? [[file, blobs.get(file)!] as const] : [])));
  return { sources: only(sources), manifests: only(manifests), files };
}

/**
 * `<sha> blob <size>\n<size bytes>\n` per hit and `<request> missing\n` per miss, in request
 * order. Sizes are bytes, so this walks the raw buffer rather than a string offset.
 */
function parseCatFileBatch(output: Buffer, files: readonly string[]): Map<string, string> {
  const contents = new Map<string, string>();
  let offset = 0;
  for (const file of files) {
    const headerEnd = output.indexOf(0x0a, offset);
    const blob = /^\S+ blob (\d+)$/.exec(output.toString('utf8', offset, headerEnd));
    offset = headerEnd + 1;
    if (!blob) continue;
    const size = Number(blob[1]);
    contents.set(file, output.toString('utf8', offset, offset + size));
    offset += size + 1;
  }
  return contents;
}

/** Every ancestor directory of the tracked paths, so `exists` answers for directories too. */
function directoriesOf(files: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>();
  for (const file of files) {
    for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) {
      if (directories.has(dir)) break;
      directories.add(dir);
    }
  }
  return directories;
}

/**
 * The walker's view of `treeish`: tracked paths from one `git ls-tree`, and every source the
 * walker can reach (production TypeScript and JSON modules under `src/` and
 * `packages/<pkg>/src/`, package manifests) from ONE `git cat-file --batch` fed those paths up
 * front -- two processes for the whole tree, never one per file. A read outside that set is a
 * widening request, not a fallback.
 */
export function createCommittedSourceTree(repoRoot: string, treeish: string): SourceTreeReader {
  const listing = listCommittedTree(repoRoot, treeish);
  const tracked = new Set(listing);
  const directories = directoriesOf(tracked);
  const { sources, jsonModules, manifests } = committedSourceSet(listing);
  const contents = readCommittedBlobs(repoRoot, treeish, [
    ...sources,
    ...jsonModules,
    ...manifests,
  ]);
  const relative = (file: string) => path.relative(repoRoot, file).split(path.sep).join('/');
  return {
    exists: (file) => tracked.has(relative(file)) || directories.has(relative(file)),
    isFile: (file) => tracked.has(relative(file)),
    readdir: (dir) => {
      const prefix = `${relative(dir)}/`;
      const names = new Set<string>();
      for (const entry of [...tracked, ...directories]) {
        if (entry.startsWith(prefix)) names.add(entry.slice(prefix.length).split('/')[0] ?? '');
      }
      names.delete('');
      return [...names].sort();
    },
    readFile: (file) => {
      const source = contents.get(relative(file));
      if (source === undefined) {
        throw new Error(`${relative(file)} is not a source the closure walker reads at ${treeish}`);
      }
      return source;
    },
  };
}
