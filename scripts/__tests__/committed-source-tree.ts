// A committed git tree as the closure walker's source of truth: the merge-base with origin/main,
// read without checking it out, so a ratchet compares against what actually landed.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { SourceTreeReader } from '../../src/__tests__/eager-import-closure.fixtures.ts';
import { isProductionSourceFile } from '../layering/tracked-sources.ts';

const WALKED_SOURCE = /^(?:src|packages\/[^/]+\/src)\/.*\.ts$/;
const WALKED_MANIFEST = /^packages\/[^/]+\/package\.json$/;

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

/** Files renamed since `base`, current path -> path at `base`, so a rename is not a new entry. */
export function renamedSince(repoRoot: string, base: string): ReadonlyMap<string, string> {
  const renamed = new Map<string, string>();
  const status = git(repoRoot, ['diff', '--name-status', '-M', '--diff-filter=R', '-z', base]);
  const fields = status.toString('utf8').split('\0');
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [from, to] = [fields[index + 1], fields[index + 2]];
    if (from && to) renamed.set(to, from);
  }
  return renamed;
}

/** Every path tracked at `treeish`, repo-root-relative, from ONE `git ls-tree`. */
function listCommittedTree(repoRoot: string, treeish: string): string[] {
  const listing = git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', treeish]).toString('utf8');
  return listing.split('\0').filter(Boolean);
}

/**
 * The sources this reader serves, split by kind: production TypeScript under `src/` and
 * `packages/<pkg>/src/`, and workspace package manifests. One definition, so a consumer reading
 * a committed tree cannot classify it differently from the walker.
 */
function committedSourceSet(tracked: readonly string[]): {
  sources: string[];
  manifests: string[];
} {
  return {
    sources: tracked.filter((file) => WALKED_SOURCE.test(file) && isProductionSourceFile(file)),
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
 * production sources and workspace manifests committed at `treeish`. A whole-tree measurement
 * (the layering ratchets) needs the corpus rather than a reader, and taking it from here is what
 * keeps its file set identical to the closure walker's.
 */
// fallow-ignore-next-line unused-export -- consumed by scripts/layering, outside fallow's scope
export function readCommittedSources(
  repoRoot: string,
  treeish: string,
): { sources: Map<string, string>; manifests: Map<string, string> } {
  const { sources, manifests } = committedSourceSet(listCommittedTree(repoRoot, treeish));
  const blobs = readCommittedBlobs(repoRoot, treeish, [...sources, ...manifests]);
  const only = (files: readonly string[]) =>
    new Map(files.flatMap((file) => (blobs.has(file) ? [[file, blobs.get(file)!] as const] : [])));
  return { sources: only(sources), manifests: only(manifests) };
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
 * walker can reach (production TypeScript under `src/` and `packages/<pkg>/src/`, package
 * manifests) from ONE `git cat-file --batch` fed those paths up front -- two processes for the
 * whole tree, never one per file. A read outside that set is a widening request, not a fallback.
 */
export function createCommittedSourceTree(repoRoot: string, treeish: string): SourceTreeReader {
  const listing = listCommittedTree(repoRoot, treeish);
  const tracked = new Set(listing);
  const directories = directoriesOf(tracked);
  const { sources, manifests } = committedSourceSet(listing);
  const contents = readCommittedBlobs(repoRoot, treeish, [...sources, ...manifests]);
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
