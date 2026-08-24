import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from '../utils/version.ts';

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
    return formatDaemonCodeSignature(walkDaemonCodeGraph(entryPath, root));
  } catch {
    return 'unknown';
  }
}

/**
 * Stamps every module reachable from `entryPath` through relative import
 * specifiers. Throws when the entry itself cannot be read; callers decide
 * whether that is an `'unknown'` signature or a cache miss.
 */
export function walkDaemonCodeGraph(entryPath: string, root: string): DaemonCodeFileStamp[] {
  const normalizedRoot = path.resolve(root);
  const queue = [path.resolve(entryPath)];
  const visited = new Set<string>();
  const stamps: DaemonCodeFileStamp[] = [];

  while (queue.length > 0) {
    const currentPath = queue.pop();
    if (!currentPath || visited.has(currentPath)) continue;
    visited.add(currentPath);

    const stat = fs.statSync(currentPath);
    if (!stat.isFile()) continue;

    stamps.push([
      buildDaemonCodeFileLabel(normalizedRoot, currentPath),
      stat.size,
      Math.trunc(stat.mtimeMs),
    ]);

    const content = fs.readFileSync(currentPath, 'utf8');
    for (const specifier of collectRelativeImportSpecifiers(content)) {
      const dependencyPath = resolveRelativeImportPath(currentPath, specifier);
      if (dependencyPath) {
        queue.push(dependencyPath);
      }
    }
  }

  return stamps;
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

function resolveRelativeImportPath(fromPath: string, specifier: string): string | null {
  const basePath = path.resolve(path.dirname(fromPath), specifier);
  const direct = resolveExistingFile(basePath);
  if (direct) return direct;

  for (const extension of RESOLVABLE_EXTENSIONS) {
    const withExtension = resolveExistingFile(`${basePath}${extension}`);
    if (withExtension) return withExtension;
  }

  for (const extension of RESOLVABLE_EXTENSIONS) {
    const indexPath = resolveExistingFile(path.join(basePath, `index${extension}`));
    if (indexPath) return indexPath;
  }

  return null;
}

function resolveExistingFile(candidatePath: string): string | null {
  try {
    return fs.statSync(candidatePath).isFile() ? candidatePath : null;
  } catch {
    return null;
  }
}
