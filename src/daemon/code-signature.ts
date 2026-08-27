import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from '@agent-device/host-kit/version';

// Any quoted, relative-path-shaped string literal is treated as a module
// specifier, rather than matching the `import`/`export`/`from` grammar
// around it: bundlers only ever emit relative string literals for real
// specifiers, but the surrounding syntax varies too much to track reliably —
// formatted source spaces `import { x } from './y'` out, a minified build
// (tsdown/rolldown `minify: true`) squashes it to `import{x}from"./y"`, and a
// keyword-anchored regex tuned for one silently stops matching the other
// (#1545: the daemon's own built entry fingerprinted to just itself, since
// nothing downstream of it ever matched). A literal that isn't really an
// import (e.g. one that shows up inside a comment) simply fails to resolve
// to a file below and gets dropped, so over-matching here is harmless.
const RELATIVE_SPECIFIER_RE = /(['"])(\.\.?\/[^'"]*)\1/g;
const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * One visited module's contribution to the fingerprint: the label it is
 * recorded under (repository-relative where possible) and the `size:mtime`
 * pair that stands in for its contents. Contents are never hashed — a
 * same-length rewrite inside one filesystem timestamp tick is deliberately
 * out of scope, and `code-signature-cache.ts` reuses exactly this bound.
 */
export type DaemonCodeFileStamp = readonly [label: string, size: number, mtimeMs: number];

/**
 * One walk of the graph: the stamps that make up its signature, plus the paths
 * whose ABSENCE that shape depended on.
 *
 * A file OUTSIDE the graph can still decide the graph. `./dep` means `dep.js`
 * only for as long as `dep.ts` does not exist, because resolution probes the
 * extensions in `RESOLVABLE_EXTENSIONS` order — and a specifier that resolves
 * to nothing today is an edge whose target merely has not been written yet.
 * `absentPaths` therefore carries every candidate probed and missed ahead of a
 * specifier's winner, and every candidate of a specifier with no winner at
 * all: creating any one of them redirects or adds an edge. Together with the
 * stamps it is the complete input to this walk, which is what lets
 * `code-signature-cache.ts` replay the result from `statSync` alone.
 */
export type DaemonCodeGraphWalk = {
  readonly files: readonly DaemonCodeFileStamp[];
  readonly absentPaths: readonly string[];
};

export function resolveDaemonCodeSignature(): string {
  const entryPath = process.argv[1];
  if (!entryPath) return 'unknown';
  return computeDaemonCodeSignature(entryPath);
}

export function computeDaemonCodeSignature(
  entryPath: string,
  root: string = findProjectRoot(),
): string {
  try {
    return formatDaemonCodeSignature(walkDaemonCodeGraph(entryPath, root).files);
  } catch {
    return 'unknown';
  }
}

/**
 * Stamps every module reachable from `entryPath` through relative import
 * specifiers, and records what every resolution along the way needed to be
 * missing. Throws when the entry itself cannot be read; callers decide whether
 * that is an `'unknown'` signature or a cache miss.
 */
export function walkDaemonCodeGraph(entryPath: string, root: string): DaemonCodeGraphWalk {
  const normalizedRoot = path.resolve(root);
  const queue = [path.resolve(entryPath)];
  const visited = new Set<string>();
  const files: DaemonCodeFileStamp[] = [];
  const absentPaths = new Set<string>();

  while (queue.length > 0) {
    const currentPath = queue.pop();
    if (!currentPath || visited.has(currentPath)) continue;
    visited.add(currentPath);

    const stat = fs.statSync(currentPath);
    if (!stat.isFile()) continue;

    files.push([
      buildDaemonCodeFileLabel(normalizedRoot, currentPath),
      stat.size,
      Math.trunc(stat.mtimeMs),
    ]);

    const content = fs.readFileSync(currentPath, 'utf8');
    for (const specifier of collectRelativeImportSpecifiers(content)) {
      const resolution = resolveRelativeImportPath(currentPath, specifier);
      for (const missed of resolution.missedCandidates) {
        absentPaths.add(buildDaemonCodeFileLabel(normalizedRoot, missed));
      }
      if (resolution.filePath) {
        queue.push(resolution.filePath);
      }
    }
  }

  return { files, absentPaths: [...absentPaths] };
}

/**
 * The label a visited module is stamped under: repository-relative where
 * possible, absolute when it lies outside the root. `code-signature-cache.ts`
 * derives the ENTRY's label through this same function, so a stored document
 * that does not list it cannot be a document for this graph.
 */
export function buildDaemonCodeFileLabel(root: string, filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  return path.relative(path.resolve(root), resolvedPath) || resolvedPath;
}

/** The wire form of a signature; identical for a walked and a cache-validated stamp list. */
export function formatDaemonCodeSignature(stamps: readonly DaemonCodeFileStamp[]): string {
  const fingerprint = stamps
    .map(([label, size, mtimeMs]) => `${label}:${size}:${mtimeMs}`)
    .sort()
    .join('|');
  const hash = crypto.createHash('sha1').update(fingerprint).digest('hex');
  return `graph:${stamps.length}:${hash}`;
}

function collectRelativeImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  RELATIVE_SPECIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = RELATIVE_SPECIFIER_RE.exec(content)) !== null) {
    specifiers.add(match[2]!);
  }
  return [...specifiers];
}

/**
 * What one specifier resolves to, and what that answer rests on: the
 * candidates probed and missed AHEAD of the winner. Candidates behind it are
 * never reached, so creating one of those cannot move the resolution and none
 * is reported.
 */
type ImportResolution = {
  readonly filePath: string | null;
  readonly missedCandidates: readonly string[];
};

function resolveRelativeImportPath(fromPath: string, specifier: string): ImportResolution {
  const basePath = path.resolve(path.dirname(fromPath), specifier);
  const missedCandidates: string[] = [];
  for (const candidatePath of resolutionCandidates(basePath)) {
    if (isExistingFile(candidatePath)) return { filePath: candidatePath, missedCandidates };
    missedCandidates.push(candidatePath);
  }
  return { filePath: null, missedCandidates };
}

/** Every path the specifier could name, in the order resolution prefers them. */
function* resolutionCandidates(basePath: string): Generator<string> {
  yield basePath;
  for (const extension of RESOLVABLE_EXTENSIONS) yield `${basePath}${extension}`;
  for (const extension of RESOLVABLE_EXTENSIONS) yield path.join(basePath, `index${extension}`);
}

function isExistingFile(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}
